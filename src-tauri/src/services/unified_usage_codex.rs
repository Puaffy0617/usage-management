//! Documented Codex App Server adapter. Credentials belong to Codex's OS
//! keyring, scoped by an isolated CODEX_HOME; this module never reads tokens.
//! No inference requests, conversation reads, or private HTTP endpoints.

use once_cell::sync::Lazy;
use process_wrap::tokio::{KillOnDrop, TokioChildWrapper, TokioCommandWrap};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const FRAME_LIMIT: usize = 4 * 1024 * 1024;
const CREDENTIAL_MARKER: &str = ".cc-switch-login-attempted";

struct Rpc {
    child: Option<Box<dyn TokioChildWrapper>>,
    input: Box<dyn AsyncWrite + Unpin + Send>,
    output: BufReader<Box<dyn AsyncRead + Unpin + Send>>,
    next_id: u64,
    notifications: VecDeque<Value>,
    unusable: bool,
}

struct Login {
    id: String,
    rpc: Mutex<Option<Rpc>>,
    cancel: watch::Sender<bool>,
    stopped: watch::Sender<bool>,
    // Keep the shared browser callback port reserved until this login is gone.
    _permit: OwnedSemaphorePermit,
}

static LOGINS: Lazy<Mutex<HashMap<String, Arc<Login>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static LOGIN_PERMIT: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));
#[cfg(test)]
static TEST_PROFILE_ROOT: Lazy<tempfile::TempDir> =
    Lazy::new(|| tempfile::tempdir().expect("isolated analytics profile test directory"));

fn profile_dir(profile_id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(profile_id).map_err(|_| "Invalid analytics account ID")?;
    // Canonical UUID names prevent traversal and isolate the user's normal CLI.
    #[cfg(not(test))]
    let root = crate::config::get_app_config_dir().join("usage-codex-profiles");
    #[cfg(test)]
    let root = TEST_PROFILE_ROOT.path().to_path_buf();
    Ok(root.join(id.to_string()))
}

/// This marker contains no credentials. It prevents failed/cancelled browser
/// flows from becoming deletable offline before their OS credential entry is
/// explicitly cleared, even if account identity was never bound to the DB.
pub fn credentials_may_exist(profile_id: &str) -> Result<bool, String> {
    profile_dir(profile_id)?
        .join(CREDENTIAL_MARKER)
        .try_exists()
        .map_err(|_| "Cannot inspect the analytics credential-cleanup marker".into())
}

fn mark_login_attempt(profile_id: &str) -> Result<(), String> {
    let marker = profile_dir(profile_id)?.join(CREDENTIAL_MARKER);
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)
    {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err("Cannot record the analytics credential-cleanup marker".into()),
    }
}

fn clear_credential_marker(profile_id: &str) -> Result<(), String> {
    match std::fs::remove_file(profile_dir(profile_id)?.join(CREDENTIAL_MARKER)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(
            "Signed out, but cannot clear the credential-cleanup marker; retry disconnect".into(),
        ),
    }
}

impl Rpc {
    async fn start(profile_id: &str) -> Result<Self, String> {
        Self::start_config(profile_id, false).await
    }

    async fn start_config(profile_id: &str, external: bool) -> Result<Self, String> {
        let dir = profile_dir(profile_id)?;
        std::fs::create_dir_all(&dir)
            .map_err(|_| "Cannot create the isolated Codex profile".to_string())?;
        let root = dir
            .parent()
            .ok_or("Invalid isolated profile directory")?
            .canonicalize()
            .map_err(|_| "Cannot resolve the isolated profile directory")?;
        let dir = dir
            .canonicalize()
            .map_err(|_| "Cannot resolve the isolated Codex profile")?;
        if dir.parent() != Some(root.as_path()) {
            return Err(
                "The isolated Codex profile must not link outside the analytics directory".into(),
            );
        }
        let std_command = tokio::task::spawn_blocking(move || {
            crate::commands::detected_tool_command(
                "codex",
                &[
                    "app-server",
                    "-c",
                    if external {
                        "cli_auth_credentials_store=\"ephemeral\""
                    } else {
                        "cli_auth_credentials_store=\"keyring\""
                    },
                    "-c",
                    "forced_login_method=\"chatgpt\"",
                ],
                Duration::from_secs(15),
            )
        })
        .await
        .map_err(|_| "Cannot locate Codex CLI".to_string())?
        .map_err(|_| {
            "Install a current official Codex CLI and make it available on PATH".to_string()
        })?;
        let mut command = Command::from(std_command);
        command
            .current_dir(&dir)
            .env("CODEX_HOME", &dir)
            .env_remove("OPENAI_API_KEY")
            .env_remove("OPENAI_BASE_URL")
            .env_remove("CODEX_API_KEY")
            .env_remove("CHATGPT_TOKEN")
            .env_remove("CODEX_AUTH_TOKEN")
            .env_remove("CODEX_ACCESS_TOKEN")
            .env_remove("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Never persist authentication diagnostics or tokens in app logs.
            .stderr(Stdio::null());
        let mut command = TokioCommandWrap::from(command);
        command.wrap(KillOnDrop);
        #[cfg(unix)]
        command.wrap(process_wrap::tokio::ProcessGroup::leader());
        #[cfg(windows)]
        {
            let mut flags = process_wrap::tokio::CreationFlags(Default::default());
            flags.0 .0 = 0x08000000; // CREATE_NO_WINDOW
            command.wrap(flags).wrap(process_wrap::tokio::JobObject);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start Codex App Server".to_string())?;
        let input = Box::new(child.stdin().take().ok_or("Codex stdin unavailable")?);
        let output: Box<dyn AsyncRead + Unpin + Send> =
            Box::new(child.stdout().take().ok_or("Codex stdout unavailable")?);
        let mut rpc = Self {
            child: Some(child),
            input,
            output: BufReader::new(output),
            next_id: 0,
            notifications: VecDeque::new(),
            unusable: false,
        };
        rpc.request(
            "initialize",
            Some(json!({
                "clientInfo": {"name":"cc_switch_usage", "title":"CC Switch Usage Analytics", "version":env!("CARGO_PKG_VERSION")},
                "capabilities": {"experimentalApi":external}
            })),
        )
        .await?;
        rpc.send(json!({"method":"initialized", "params":{}}))
            .await?;
        Ok(rpc)
    }

    async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "Cannot encode Codex request")?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "Codex connection closed")?;
        self.input
            .flush()
            .await
            .map_err(|_| "Codex connection closed".to_string())
    }

    async fn next(&mut self) -> Result<Value, String> {
        let mut frame = Vec::new();
        loop {
            // Enforce the bound before allocation, even for a stream without a newline.
            let available = self
                .output
                .fill_buf()
                .await
                .map_err(|_| "Cannot read Codex response")?;
            if available.is_empty() {
                return Err("Codex App Server stopped. Check CLI installation and OS credential store availability".into());
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let count = newline.map_or(available.len(), |index| index + 1);
            if frame.len().saturating_add(count) > FRAME_LIMIT {
                return Err("Codex response exceeds the supported size".into());
            }
            frame.extend_from_slice(&available[..count]);
            self.output.consume(count);
            if newline.is_some() {
                break;
            }
        }
        serde_json::from_slice(&frame).map_err(|_| "Invalid Codex App Server response".to_string())
    }

    async fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        if self.unusable {
            return Err(
                "Codex connection is unavailable after a transport failure; refresh to retry"
                    .into(),
            );
        }
        self.next_id += 1;
        let id = self.next_id;
        let mut request = json!({"method":method,"id":id});
        if let Some(params) = params {
            request["params"] = params;
        }
        let result = tokio::time::timeout(REQUEST_TIMEOUT, async {
            if let Err(error) = self.send(request).await {
                self.unusable = true;
                return Err(error);
            }
            loop {
                let value = match self.next().await {
                    Ok(value) => value,
                    Err(error) => { self.unusable = true; return Err(error); }
                };
                if value.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(error) = value.get("error") {
                        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
                        return Err(if code == -32601 {
                            format!("{method} is unavailable in this Codex version; upgrade the official CLI")
                        } else {
                            format!("Codex {method} failed (code {code}). Reconnect if authentication expired; OS keyring is required")
                        });
                    }
                    return value.get("result").cloned().ok_or_else(|| "Missing Codex result".to_string());
                }
                if value.get("method").is_some() && value.get("id").is_none() {
                    if self.notifications.len() >= 64 { self.notifications.pop_front(); }
                    self.notifications.push_back(value);
                } else if value.get("method").is_some() {
                    let Some(server_id) = value.get("id") else { continue; };
                    // The original manager remains the sole refresh-token owner.
                    // An expired external token never causes an analytics logout,
                    // replacement browser login, or a copied refresh-token chain.
                    let expired = value.get("method").and_then(Value::as_str) == Some("account/chatgptAuthTokens/refresh");
                    self.send(json!({"id":server_id,"error":{
                        "code":if expired {-32001} else {-32601},
                        "message":if expired {"Refresh the existing CC Switch account session; its sign-in has not been removed"} else {"Unsupported host request"}
                    }})).await?;
                }
            }
        }).await;
        match result {
            Ok(result) => result,
            Err(_) => {
                // A cancelled frame read can leave the JSONL stream mid-frame.
                // Never reuse it for the next request after a timeout.
                self.unusable = true;
                Err(format!("Codex {method} timed out"))
            }
        }
    }

    async fn wait_login(&mut self, login_id: &str) -> Result<(), String> {
        loop {
            let value = match self.notifications.pop_front() {
                Some(value) => value,
                None => self.next().await?,
            };
            if value.get("method").and_then(Value::as_str) == Some("account/login/completed")
                && value.pointer("/params/loginId").and_then(Value::as_str) == Some(login_id)
            {
                return if value.pointer("/params/success").and_then(Value::as_bool) == Some(true) {
                    Ok(())
                } else {
                    Err("ChatGPT sign-in was not completed; retry sign-in and check OS keyring availability".into())
                };
            }
            if value.get("method").is_some() {
                if let Some(server_id) = value.get("id") {
                    self.send(json!({"id":server_id,"error":{"code":-32601,"message":"Unsupported host request"}})).await?;
                }
            }
        }
    }

    async fn stop(mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), Box::into_pin(child.wait())).await;
        }
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Kill the launcher and its children on every early error/cancellation.
            let _ = child.start_kill();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ =
                        tokio::time::timeout(Duration::from_secs(5), Box::into_pin(child.wait()))
                            .await;
                });
            }
        }
    }
}

fn require_chatgpt(value: &Value) -> Result<(), String> {
    if value.pointer("/account/type").and_then(Value::as_str) != Some("chatgpt") {
        return Err(
            "ChatGPT account is disconnected. Reconnect using the official browser sign-in".into(),
        );
    }
    Ok(())
}

pub async fn start_login(profile_id: &str) -> Result<Value, String> {
    // The official browser callback uses a shared port. Serialize browser logins.
    let permit = LOGIN_PERMIT
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Complete or cancel the current account sign-in first")?;
    let mut rpc = Rpc::start(profile_id).await?;
    // Browser completion may persist credentials before the UI binds identity.
    // Retain this marker through all failures/cancellations until a real logout.
    mark_login_attempt(profile_id)?;
    let result = rpc
        .request("account/login/start", Some(json!({"type":"chatgpt"})))
        .await?;
    let login_id = result
        .get("loginId")
        .and_then(Value::as_str)
        .ok_or("Missing login ID")?
        .to_string();
    let auth_url = result
        .get("authUrl")
        .and_then(Value::as_str)
        .ok_or("Missing sign-in URL")?;
    let url = url::Url::parse(auth_url).map_err(|_| "Invalid sign-in URL")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("auth.openai.com" | "chatgpt.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err("Codex returned an unexpected sign-in host".into());
    }
    let (cancel, mut cancellation) = watch::channel(false);
    let (stopped, _) = watch::channel(false);
    let login = Arc::new(Login {
        id: login_id,
        rpc: Mutex::new(Some(rpc)),
        cancel,
        stopped,
        _permit: permit,
    });
    LOGINS
        .lock()
        .await
        .insert(profile_id.to_string(), Arc::clone(&login));
    let profile = profile_id.to_string();
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(LOGIN_TIMEOUT) => {
                remove_login(&profile, &login).await;
                let _ = stop_pending_login(&login).await;
            },
            _ = async { let _ = cancellation.wait_for(|cancelled| *cancelled).await; } => {}
        }
    });
    Ok(result)
}

async fn remove_login(profile_id: &str, login: &Arc<Login>) {
    let mut logins = LOGINS.lock().await;
    if logins
        .get(profile_id)
        .is_some_and(|current| Arc::ptr_eq(current, login))
    {
        logins.remove(profile_id);
    }
}

async fn stop_pending_login(login: &Login) -> Result<(), String> {
    login.cancel.send_replace(true);
    let rpc = login.rpc.lock().await.take();
    if let Some(rpc) = rpc {
        rpc.stop().await;
        login.stopped.send_replace(true);
    } else {
        // finish_login owns the process. Wait for its cancellation cleanup before
        // a new logout process can race a late browser callback/credential write.
        let mut stopped = login.stopped.subscribe();
        tokio::time::timeout(
            Duration::from_secs(10),
            stopped.wait_for(|stopped| *stopped),
        )
        .await
        .map_err(|_| "Timed out stopping the pending sign-in; retry disconnect")?
        .map_err(|_| "Sign-in cleanup stopped unexpectedly")?;
    }
    Ok(())
}

pub async fn finish_login(profile_id: &str, login_id: &str) -> Result<Value, String> {
    let login = LOGINS
        .lock()
        .await
        .get(profile_id)
        .cloned()
        .ok_or("Sign-in expired or cancelled")?;
    if login.id != login_id {
        return Err("Sign-in does not belong to this account".into());
    }
    let mut rpc = login
        .rpc
        .lock()
        .await
        .take()
        .ok_or("Sign-in is already being completed")?;
    let mut cancellation = login.cancel.subscribe();
    let result = tokio::select! {
        biased;
        _ = async { let _ = cancellation.wait_for(|cancelled| *cancelled).await; } => Err("Sign-in cancelled or timed out".to_string()),
        result = tokio::time::timeout(LOGIN_TIMEOUT, async {
            rpc.wait_login(login_id).await?;
            let value = rpc.request("account/read", Some(json!({"refreshToken":false}))).await?;
            require_chatgpt(&value)?;
            Ok::<_, String>(value)
        }) => {
            match result {
                Ok(value) => value,
                Err(_) => Err("ChatGPT sign-in timed out".into()),
            }
        }
    };
    remove_login(profile_id, &login).await;
    login.cancel.send_replace(true);
    rpc.stop().await;
    login.stopped.send_replace(true);
    result
}

pub async fn cancel_login(profile_id: &str, login_id: &str) -> Result<(), String> {
    let login = {
        let mut logins = LOGINS.lock().await;
        if let Some(login) = logins.get(profile_id) {
            if login.id != login_id {
                return Err("Sign-in does not belong to this account".into());
            }
        }
        logins.remove(profile_id)
    };
    if let Some(login) = login {
        stop_pending_login(&login).await?;
    }
    Ok(())
}

/// Cancel a pending browser flow without requiring an installed CLI. Used when
/// managing import-only or never-connected profiles while offline.
pub async fn cancel_pending(profile_id: &str) -> Result<(), String> {
    profile_dir(profile_id)?;
    let login = LOGINS.lock().await.remove(profile_id);
    if let Some(login) = login {
        stop_pending_login(&login).await?;
    }
    Ok(())
}

pub async fn sync(profile_id: &str) -> Result<Value, String> {
    let mut rpc = Rpc::start(profile_id).await?;
    let result = async {
        let account = rpc
            .request("account/read", Some(json!({"refreshToken":true})))
            .await?;
        require_chatgpt(&account)?;
        collect_usage(&mut rpc, account).await
    }
    .await;
    rpc.stop().await;
    result
}

async fn collect_usage(rpc: &mut Rpc, account: Value) -> Result<Value, String> {
    // These are independent; unavailable token activity must not hide valid quota.
    let usage = rpc.request("account/usage/read", None).await;
    let limits = rpc.request("account/rateLimits/read", None).await;
    let mut errors = Vec::new();
    let usage = usage.unwrap_or_else(|error| {
        errors.push(error);
        Value::Null
    });
    let limits = limits.unwrap_or_else(|error| {
        errors.push(error);
        Value::Null
    });
    Ok(json!({"account":account["account"], "usage":usage, "rateLimits":limits, "errors":errors}))
}

/// Borrow a short-lived access token from CC Switch's existing account owner.
/// No refresh/id token is accepted, no credentials are persisted, and no logout
/// request is ever sent. Importing metadata does not invoke this function.
pub async fn sync_external(
    profile_id: &str,
    access_token: String,
    workspace_id: String,
) -> Result<Value, String> {
    if access_token.is_empty()
        || access_token.len() > 65_536
        || workspace_id.trim().is_empty()
        || workspace_id.len() > 512
    {
        return Err("Existing CC Switch account credentials are unavailable; the original sign-in is unchanged".into());
    }
    let mut rpc = Rpc::start_config(profile_id, true).await?;
    let result = sync_external_rpc(&mut rpc, access_token, workspace_id).await;
    // Termination drops only this ephemeral process; it cannot revoke the owner.
    rpc.stop().await;
    result
}

async fn sync_external_rpc(
    rpc: &mut Rpc,
    access_token: String,
    workspace_id: String,
) -> Result<Value, String> {
    rpc.request(
        "account/login/start",
        Some(json!({
            "type":"chatgptAuthTokens",
            "accessToken":access_token,
            "chatgptAccountId":workspace_id
        })),
    )
    .await?;
    // External auth refresh is owned by the host, not by this CLI profile.
    let account = rpc
        .request("account/read", Some(json!({"refreshToken":false})))
        .await?;
    require_chatgpt(&account)?;
    collect_usage(rpc, account).await
}

pub async fn disconnect(profile_id: &str) -> Result<(), String> {
    // account/logout clears only this profile's keyring entry. Never touch ~/.codex.
    cancel_pending(profile_id).await?;
    let mut rpc = Rpc::start(profile_id).await?;
    let result = rpc.request("account/logout", None).await.map(|_| ());
    rpc.stop().await;
    result?;
    clear_credential_marker(profile_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replay_rpc() -> (Rpc, tokio::io::DuplexStream) {
        let (client, server) = tokio::io::duplex(8192);
        let (input, output) = tokio::io::split(client);
        (
            Rpc {
                child: None,
                input: Box::new(output),
                output: BufReader::new(Box::new(input)),
                next_id: 0,
                notifications: VecDeque::new(),
                unusable: false,
            },
            server,
        )
    }

    fn replay_login(rpc: Rpc) -> Arc<Login> {
        let (cancel, _) = watch::channel(false);
        let (stopped, _) = watch::channel(false);
        Arc::new(Login {
            id: "replay-login".into(),
            rpc: Mutex::new(Some(rpc)),
            cancel,
            stopped,
            _permit: Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
        })
    }

    #[tokio::test]
    async fn linked_account_sync_uses_only_ephemeral_access_token_and_never_logs_out() {
        let (mut rpc, server) = replay_rpc();
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let responses = [
                json!({"type":"chatgptAuthTokens"}),
                json!({"account":{"type":"chatgpt","email":"linked@example.test","planType":"pro"}}),
                json!({"summary":{"lifetimeTokens":7},"dailyUsageBuckets":null}),
                json!({"rateLimits":null}),
            ];
            let methods = [
                "account/login/start",
                "account/read",
                "account/usage/read",
                "account/rateLimits/read",
            ];
            for (index, result) in responses.into_iter().enumerate() {
                let mut line = String::new();
                server.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["method"], methods[index]);
                if index == 0 {
                    assert_eq!(request["params"]["type"], "chatgptAuthTokens");
                    assert_eq!(request["params"]["accessToken"], "test-ephemeral-access");
                    assert_eq!(request["params"]["chatgptAccountId"], "test-workspace");
                    assert!(request["params"].get("refreshToken").is_none());
                    assert!(request["params"].get("idToken").is_none());
                }
                if index == 1 {
                    assert_eq!(request["params"]["refreshToken"], false);
                }
                server
                    .get_mut()
                    .write_all(
                        format!("{}\n", json!({"id":request["id"],"result":result})).as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            // A logout or browser login here would violate the preserved session.
            let mut extra = String::new();
            assert_eq!(server.read_line(&mut extra).await.unwrap(), 0);
        });
        let result = sync_external_rpc(
            &mut rpc,
            "test-ephemeral-access".into(),
            "test-workspace".into(),
        )
        .await
        .unwrap();
        assert_eq!(result["account"]["email"], "linked@example.test");
        assert_eq!(result["usage"]["summary"]["lifetimeTokens"], 7);
        rpc.stop().await;
        task.await.unwrap();
    }

    #[tokio::test]
    async fn rejected_linked_session_never_refreshes_or_logs_out_the_original_account() {
        let (mut rpc, server) = replay_rpc();
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut line = String::new();
            server.read_line(&mut line).await.unwrap();
            server
                .get_mut()
                .write_all(b"{\"id\":1,\"result\":{\"type\":\"chatgptAuthTokens\"}}\n")
                .await
                .unwrap();
            line.clear();
            server.read_line(&mut line).await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap()["method"],
                "account/read"
            );
            server.get_mut().write_all(b"{\"id\":\"refresh-fixture\",\"method\":\"account/chatgptAuthTokens/refresh\",\"params\":{\"reason\":\"unauthorized\"}}\n").await.unwrap();
            line.clear();
            server.read_line(&mut line).await.unwrap();
            let refusal: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(refusal["error"]["code"], -32001);
            assert!(refusal.get("result").is_none());
            server
                .get_mut()
                .write_all(b"{\"id\":2,\"error\":{\"code\":401}}\n")
                .await
                .unwrap();
            line.clear();
            assert_eq!(server.read_line(&mut line).await.unwrap(), 0);
        });
        assert!(sync_external_rpc(
            &mut rpc,
            "expired-test-access".into(),
            "test-workspace".into()
        )
        .await
        .is_err());
        rpc.stop().await;
        task.await.unwrap();
    }

    #[tokio::test]
    async fn credential_marker_survives_cancel_until_explicit_successful_cleanup() {
        let id = uuid::Uuid::new_v4().to_string();
        let profile = profile_dir(&id).unwrap();
        assert!(profile.starts_with(TEST_PROFILE_ROOT.path()));
        std::fs::create_dir(&profile).unwrap();
        assert!(!credentials_may_exist(&id).unwrap());
        mark_login_attempt(&id).unwrap();
        mark_login_attempt(&id).unwrap(); // Reconnect must preserve the marker.
        assert!(credentials_may_exist(&id).unwrap());
        assert_eq!(
            std::fs::metadata(profile.join(CREDENTIAL_MARKER))
                .unwrap()
                .len(),
            0
        );
        // No active RPC or installed CLI is needed to cancel this pending state.
        cancel_pending(&id).await.unwrap();
        assert!(credentials_may_exist(&id).unwrap());
        // Production invokes this helper only after account/logout succeeds.
        clear_credential_marker(&id).unwrap();
        assert!(!credentials_may_exist(&id).unwrap());
        std::fs::remove_dir(profile).unwrap();
    }

    #[tokio::test]
    async fn failed_account_read_after_login_cleans_up_the_pending_session() {
        let id = uuid::Uuid::new_v4().to_string();
        let (mut rpc, server) = replay_rpc();
        rpc.notifications.push_back(json!({"method":"account/login/completed","params":{"loginId":"replay-login","success":true}}));
        let login = replay_login(rpc);
        LOGINS.lock().await.insert(id.clone(), login.clone());
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut request = String::new();
            server.read_line(&mut request).await.unwrap();
            server
                .get_mut()
                .write_all(b"{\"id\":1,\"error\":{\"code\":-32000}}\n")
                .await
                .unwrap();
        });
        assert!(finish_login(&id, "replay-login").await.is_err());
        assert!(!LOGINS.lock().await.contains_key(&id));
        assert!(*login.stopped.borrow());
        task.await.unwrap();
    }

    #[tokio::test]
    async fn cancel_pending_never_launches_a_cli_and_closes_the_waiting_rpc() {
        let id = uuid::Uuid::new_v4().to_string();
        let (rpc, _server) = replay_rpc();
        let login = replay_login(rpc);
        LOGINS.lock().await.insert(id.clone(), login.clone());
        cancel_pending(&id).await.unwrap();
        assert!(!LOGINS.lock().await.contains_key(&id));
        assert!(login.rpc.lock().await.is_none());
        assert!(*login.stopped.borrow());
        cancel_pending(&id).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_waits_for_an_active_finish_to_stop_its_rpc() {
        let id = uuid::Uuid::new_v4().to_string();
        let (rpc, _server) = replay_rpc();
        let login = replay_login(rpc);
        LOGINS.lock().await.insert(id.clone(), login.clone());
        let profile = id.clone();
        let finish = tokio::spawn(async move { finish_login(&profile, "replay-login").await });
        for _ in 0..100 {
            if login.rpc.lock().await.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(login.rpc.lock().await.is_none());
        cancel_pending(&id).await.unwrap();
        assert!(*login.stopped.borrow());
        assert!(finish.await.unwrap().unwrap_err().contains("cancelled"));
    }

    #[tokio::test]
    async fn login_completion_before_login_response_is_preserved() {
        let (mut rpc, server) = replay_rpc();
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut request = String::new();
            server.read_line(&mut request).await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&request).unwrap()["method"],
                "account/login/start"
            );
            server.get_mut().write_all(concat!(
                "{\"method\":\"account/login/completed\",\"params\":{\"loginId\":\"test-login\",\"success\":true}}\n",
                "{\"id\":1,\"result\":{\"loginId\":\"test-login\"}}\n"
            ).as_bytes()).await.unwrap();
        });
        rpc.request("account/login/start", Some(json!({"type":"chatgpt"})))
            .await
            .unwrap();
        rpc.wait_login("test-login").await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn unsupported_usage_method_does_not_hide_quota_response() {
        let (mut rpc, server) = replay_rpc();
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut request = String::new();
            server.read_line(&mut request).await.unwrap();
            server
                .get_mut()
                .write_all(b"{\"id\":1,\"error\":{\"code\":-32601,\"message\":\"test\"}}\n")
                .await
                .unwrap();
            request.clear();
            server.read_line(&mut request).await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&request).unwrap()["method"],
                "account/rateLimits/read"
            );
            server
                .get_mut()
                .write_all(b"{\"id\":2,\"result\":{\"rateLimits\":null}}\n")
                .await
                .unwrap();
        });
        assert!(rpc
            .request("account/usage/read", None)
            .await
            .unwrap_err()
            .contains("upgrade"));
        assert_eq!(
            rpc.request("account/rateLimits/read", None).await.unwrap(),
            json!({"rateLimits":null})
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn host_requests_are_rejected_without_executing_them() {
        let (mut rpc, server) = replay_rpc();
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut request = String::new();
            server.read_line(&mut request).await.unwrap();
            server
                .get_mut()
                .write_all(
                    b"{\"id\":\"host-test\",\"method\":\"execCommandApproval\",\"params\":{}}\n",
                )
                .await
                .unwrap();
            request.clear();
            server.read_line(&mut request).await.unwrap();
            let rejection: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(rejection["id"], "host-test");
            assert_eq!(rejection["error"]["code"], -32601);
            server
                .get_mut()
                .write_all(b"{\"id\":1,\"result\":{\"account\":null}}\n")
                .await
                .unwrap();
        });
        assert_eq!(
            rpc.request("account/read", None).await.unwrap(),
            json!({"account":null})
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn response_size_is_bounded_before_a_newline_arrives() {
        let (mut rpc, mut server) = replay_rpc();
        let task = tokio::spawn(async move {
            let bytes = vec![b'x'; FRAME_LIMIT + 1];
            let _ = server.write_all(&bytes).await;
        });
        assert!(rpc.next().await.unwrap_err().contains("size"));
        task.abort();
    }

    #[tokio::test]
    async fn cancellation_is_visible_to_subscribers_created_after_cancel() {
        let (cancel, _) = watch::channel(false);
        cancel.send_replace(true);
        let mut subscriber = cancel.subscribe();
        tokio::time::timeout(
            Duration::from_millis(100),
            subscriber.wait_for(|value| *value),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_rpc_connection_cannot_be_reused() {
        let (mut rpc, _server) = replay_rpc();
        assert!(rpc
            .request("account/read", None)
            .await
            .unwrap_err()
            .contains("timed out"));
        assert!(rpc
            .request("account/rateLimits/read", None)
            .await
            .unwrap_err()
            .contains("transport failure"));
    }

    #[test]
    fn profile_paths_require_uuid() {
        for bad in ["../codex", "", "C:\\private", "account-a"] {
            assert!(profile_dir(bad).is_err());
        }
    }

    #[test]
    fn only_chatgpt_auth_is_accepted() {
        assert!(require_chatgpt(&json!({"account":{"type":"apiKey"}})).is_err());
        assert!(require_chatgpt(&json!({"account":null})).is_err());
        assert!(require_chatgpt(&json!({"account":{"type":"chatgpt","email":null}})).is_ok());
    }
}
