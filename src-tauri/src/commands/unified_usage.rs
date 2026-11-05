//! Native analytics commands. Every database scan runs outside the UI thread.
use crate::database::Database;
use crate::error::AppError;
use crate::proxy::providers::codex_oauth_auth::CodexOAuthError;
use crate::services::{unified_usage::*, unified_usage_codex as codex};
use crate::store::AppState;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::State;
use tokio::sync::Mutex;

async fn db_task<T, F>(state: &State<'_, AppState>, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Database) -> Result<T, AppError> + Send + 'static,
{
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || task(&db))
        .await
        .map_err(|e| format!("Analytics database task failed: {e}"))?
        .map_err(|e| e.to_string())
}

async fn profile_lock(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await
        .entry(id.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[tauri::command]
pub async fn unified_usage_list_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<AnalyticsAccount>, String> {
    unified_usage_reconcile_original_metadata(state.inner()).await
}

/// Startup/auth-center/list hook: metadata only, with no credential refresh or
/// reactivation of subscriptions the user intentionally disconnected.
pub async fn unified_usage_reconcile_original_metadata(
    state: &AppState,
) -> Result<Vec<AnalyticsAccount>, String> {
    let sources = state
        .codex_oauth_manager
        .list_accounts()
        .await
        .into_iter()
        .map(|account| ExistingAccountMetadata {
            provider_account_id: account.id,
            login: account.login,
            reauth_required: account.reauth_required,
        })
        .collect::<Vec<_>>();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.unified_usage_reconcile_existing_accounts(&sources)
            .map(|result| result.accounts)
    })
    .await
    .map_err(|e| format!("Account discovery task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unified_usage_import_existing_accounts(
    state: State<'_, AppState>,
) -> Result<ExistingAccountsImportResult, String> {
    // list_accounts is a metadata-only in-memory read. Import must never refresh
    // a token, change a default/provider, overwrite native auth, or sign out.
    let sources = state
        .codex_oauth_manager
        .list_accounts()
        .await
        .into_iter()
        .map(|account| ExistingAccountMetadata {
            provider_account_id: account.id,
            login: account.login,
            reauth_required: account.reauth_required,
        })
        .collect::<Vec<_>>();
    db_task(&state, move |db| {
        db.unified_usage_import_existing_accounts(&sources)
    })
    .await
}

#[tauri::command]
pub async fn unified_usage_add_account(
    state: State<'_, AppState>,
    name: String,
) -> Result<AnalyticsAccount, String> {
    db_task(&state, move |db| db.unified_usage_add_account(&name)).await
}

#[tauri::command]
pub async fn unified_usage_update_account(
    state: State<'_, AppState>,
    account_id: String,
    name: String,
    sync_interval_minutes: u32,
) -> Result<AnalyticsAccount, String> {
    db_task(&state, move |db| {
        db.unified_usage_update_account(&account_id, &name, sync_interval_minutes)
    })
    .await
}

#[tauri::command]
pub async fn unified_usage_remove_account(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let lock = profile_lock(&account_id).await;
    let _guard = lock.lock().await;
    let id = account_id.clone();
    let account = db_task(&state, move |db| db.unified_usage_account(&id)).await?;
    if account.linked_account_id.is_some() {
        return db_task(&state, move |db| {
            db.unified_usage_remove_account(&account_id)
        })
        .await;
    }
    codex::cancel_pending(&account_id).await?;
    if account.identity.is_some() || codex::credentials_may_exist(&account_id)? {
        codex::disconnect(&account_id).await?;
    }
    db_task(&state, move |db| {
        db.unified_usage_remove_account(&account_id)
    })
    .await
}

#[tauri::command]
pub async fn unified_usage_disconnect_account(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let lock = profile_lock(&account_id).await;
    let _guard = lock.lock().await;
    let id = account_id.clone();
    let account = db_task(&state, move |db| db.unified_usage_account(&id)).await?;
    if account.linked_account_id.is_some() {
        return db_task(&state, move |db| {
            db.unified_usage_disconnect_linked(&account_id)
        })
        .await;
    }
    codex::cancel_pending(&account_id).await?;
    if account.identity.is_some() || codex::credentials_may_exist(&account_id)? {
        codex::disconnect(&account_id).await?;
    }
    db_task(&state, move |db| {
        db.unified_usage_set_status(&account_id, "disconnected", None)
    })
    .await
}

#[tauri::command]
pub async fn unified_usage_start_login(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Value, String> {
    let lock = profile_lock(&account_id).await;
    let _guard = lock.lock().await;
    let id = account_id.clone();
    let account = db_task(&state, move |db| db.unified_usage_account(&id)).await?;
    if account.linked_account_id.is_some() {
        return Err("Reconnect this linked account in the original CC Switch Accounts panel, then import existing accounts again; or add a separate analytics profile.".into());
    }
    let result = codex::start_login(&account_id).await;
    if result.is_ok() {
        db_task(&state, move |db| {
            db.unified_usage_set_status(&account_id, "pending", None)
        })
        .await?;
    }
    result
}

#[tauri::command]
pub async fn unified_usage_finish_login(
    state: State<'_, AppState>,
    account_id: String,
    login_id: String,
) -> Result<AnalyticsAccount, String> {
    let result = codex::finish_login(&account_id, &login_id).await;
    let lock = profile_lock(&account_id).await;
    let _guard = lock.lock().await;
    let id = account_id.clone();
    let current = db_task(&state, move |db| db.unified_usage_account(&id)).await?;
    if current.connection_status != "pending" {
        return Err("Sign-in was cancelled or the account was disconnected".into());
    }
    let account = match result {
        Ok(account) => account,
        Err(error) => {
            let id = account_id.clone();
            let message = error.clone();
            let _ = db_task(&state, move |db| {
                db.unified_usage_set_status(&id, "error", Some(&message))
            })
            .await;
            return Err(error);
        }
    };
    let id = account_id.clone();
    let bound = db_task(&state, move |db| {
        db.unified_usage_bind_identity(&id, &account)?;
        db.unified_usage_account(&id)
    })
    .await;
    match bound {
        Ok(account) => Ok(account),
        Err(error) => {
            let (status,message)=match codex::disconnect(&account_id).await {
                Ok(())=>("disconnected",error),
                Err(logout_error)=>("error",format!("{error}. Secure account sign-out did not finish: {logout_error}. Retry Disconnect before removing this profile.")),
            };
            let note = message.clone();
            db_task(&state, move |db| {
                db.unified_usage_set_status(&account_id, status, Some(&note))
            })
            .await?;
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn unified_usage_cancel_login(
    state: State<'_, AppState>,
    account_id: String,
    login_id: String,
) -> Result<(), String> {
    codex::cancel_login(&account_id, &login_id).await?;
    db_task(&state, move |db| {
        db.unified_usage_set_status(&account_id, "disconnected", None)
    })
    .await
}

#[derive(serde::Serialize)]
pub struct SyncResult {
    pub accounts: Vec<AnalyticsAccount>,
    pub errors: Vec<String>,
}

fn error_status(error: &str) -> &'static str {
    let lower = error.to_lowercase();
    if [
        "expired",
        "disconnected",
        "browser sign-in",
        "requires sign-in",
        "unauthorized",
        "not authenticated",
        "sign in",
        "401",
        "403",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        "reauth_required"
    } else if [
        "method not found",
        "not supported",
        "unsupported",
        "is unavailable in this codex version",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        "unsupported"
    } else {
        "error"
    }
}

#[tauri::command]
pub async fn unified_usage_sync(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<SyncResult, String> {
    let accounts = db_task(&state, Database::unified_usage_accounts).await?;
    let targets: Vec<_> = accounts
        .into_iter()
        .filter(|a| {
            account_id.as_ref().map_or(
                a.connection_status != "disconnected" && a.identity.is_some(),
                |id| id == &a.id,
            )
        })
        .collect();
    if account_id.is_some() && targets.is_empty() {
        return Err("Analytics account not found".into());
    }
    let mut errors = Vec::new();
    // An individual failure cannot abort another account. Serialize each profile
    // so a slow automatic refresh cannot race a manual refresh or disconnect.
    for target in targets {
        let lock = profile_lock(&target.id).await;
        let _guard = lock.lock().await;
        // The list may be stale after waiting for another account/network read.
        // Respect a disconnect/delete or browser sign-in that happened meanwhile.
        let id = target.id.clone();
        let current = match db_task(&state, move |db| db.unified_usage_account(&id)).await {
            Ok(account) => account,
            Err(error) => {
                errors.push(format!("{}: {error}", target.name));
                continue;
            }
        };
        if current.connection_status == "disconnected"
            || current.connection_status == "pending"
            || current.identity.is_none()
        {
            if account_id.is_some() {
                errors.push(format!(
                    "{}: Complete account sign-in before refreshing usage",
                    target.name
                ));
            }
            continue;
        }
        let id = target.id.clone();
        let run = db_task(&state, move |db| {
            db.unified_usage_begin_sync(&id, "codex_app_server")
        })
        .await?;
        let outcome = if let Some(source_id) = current.linked_account_id.as_deref() {
            // The original account manager remains the only refresh-token owner.
            // Only a short-lived access token crosses the in-memory RPC bridge.
            let manager = &state.codex_oauth_manager;
            async {
                let token=manager.get_valid_token_for_account(source_id).await.map_err(|error|match error {
                    CodexOAuthError::AccountNotFound(_) | CodexOAuthError::AccountUnavailable(_) | CodexOAuthError::RefreshTokenInvalid | CodexOAuthError::ExpiredToken | CodexOAuthError::AccessDenied=>"Linked account requires sign-in in the original CC Switch Accounts panel; then import existing accounts again".to_owned(),
                    _=>format!("Cannot refresh the original CC Switch account: {error}"),
                })?;
                let workspace=manager.chatgpt_account_id_for_account(source_id).await.map_err(|_|"Linked account requires sign-in in the original CC Switch Accounts panel".to_owned())?;
                codex::sync_external(&target.id,token,workspace).await
            }.await
        } else {
            codex::sync(&target.id).await
        };
        let processed = match outcome {
            Ok(payload) => {
                let id = target.id.clone();
                db_task(&state,move|db|{
                    let account=payload.get("account").filter(|v|!v.is_null()).ok_or_else(||AppError::InvalidInput("Codex did not report the authenticated account".into()))?;
                    db.unified_usage_bind_identity(&id,account)?;
                    let usage=payload.get("usage").filter(|v|!v.is_null());
                    let quota=payload.get("rateLimits").filter(|v|!v.is_null());
                    let warnings=payload.get("errors").and_then(Value::as_array).map(|items|items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")).unwrap_or_default();
                    if usage.is_none() && quota.is_none() {return Err(AppError::Message(if warnings.is_empty(){"The installed Codex service did not return supported usage or rate-limit data".into()}else{warnings}));}
                    let count=db.unified_usage_apply_official(&id,usage,quota)?;
                    db.unified_usage_set_status(&id,"connected",(!warnings.is_empty()).then_some(warnings.as_str()))?;
                    Ok((count,warnings))
                }).await
            }
            Err(error) => Err(error),
        };
        match processed {
            Ok((count, warnings)) => {
                let status = if warnings.is_empty() {
                    "success"
                } else {
                    "partial"
                };
                let note = (!warnings.is_empty()).then_some(warnings.clone());
                db_task(&state, move |db| {
                    db.unified_usage_finish_sync(&run, status, count, note.as_deref())
                })
                .await?;
                if !warnings.is_empty() {
                    errors.push(format!("{}: {warnings}", target.name));
                }
            }
            Err(error) => {
                let id = target.id.clone();
                let message = error.clone();
                db_task(&state, move |db| {
                    db.unified_usage_set_status(&id, error_status(&message), Some(&message))?;
                    db.unified_usage_finish_sync(&run, "error", 0, Some(&message))
                })
                .await?;
                errors.push(format!("{}: {error}", target.name));
            }
        }
    }
    Ok(SyncResult {
        accounts: db_task(&state, Database::unified_usage_accounts).await?,
        errors,
    })
}

#[tauri::command]
pub async fn unified_usage_dashboard(
    state: State<'_, AppState>,
    filter: AnalyticsFilter,
) -> Result<AnalyticsDashboard, String> {
    db_task(&state, move |db| db.unified_usage_dashboard(&filter)).await
}

#[tauri::command]
pub async fn unified_usage_import(
    state: State<'_, AppState>,
    account_id: String,
    path: PathBuf,
    format: String,
) -> Result<ImportResult, String> {
    db_task(&state,move|db|{
        let metadata=std::fs::metadata(&path).map_err(|e|AppError::io(&path,e))?;
        if !metadata.is_file() || metadata.len()>MAX_IMPORT_BYTES {return Err(AppError::InvalidInput("Choose a JSON file no larger than 128 MiB; extract ChatGPT ZIP archives first".into()));}
        let file=std::fs::File::open(&path).map_err(|e|AppError::io(&path,e))?;
        let document:Value=serde_json::from_reader(std::io::BufReader::new(file)).map_err(|e|AppError::InvalidInput(format!("Invalid import JSON: {e}")))?;
        if format=="backup" {
            let backup:AnalyticsBackup=serde_json::from_value(document).map_err(|e|AppError::InvalidInput(format!("Invalid analytics backup: {e}")))?;
            return db.unified_usage_restore(&backup);
        }
        let run=db.unified_usage_begin_sync(&account_id,"manual_import")?;
        let outcome=(||{
            match format.as_str() {
                "chatgpt_export"=>{
                    let (rows,warnings)=chatgpt_export_observations(&account_id,&document)?;
                    let mut result=db.unified_usage_import_observations(&account_id,&rows)?;result.warnings=warnings;Ok(result)
                }
                "observations"=>{
                    let mut rows:Vec<UsageObservation>=serde_json::from_value(document).map_err(|e|AppError::InvalidInput(format!("Invalid observation array: {e}")))?;
                    for row in &mut rows {
                        row.account_id=account_id.clone();
                        if row.provenance=="official" {return Err(AppError::InvalidInput("Custom imports may declare local or estimated provenance; official data is fetched through the supported account adapter".into()));}
                        if row.source!="imported_usage" || !row.scope.starts_with("imported:") {return Err(AppError::InvalidInput("Custom records require source imported_usage and an explicit imported:<namespace> scope".into()));}
                    }
                    let mut result=db.unified_usage_import_observations(&account_id,&rows)?;
                    result.warnings.push("Imported namespaces are independent coverage sets. Compare them separately; overlapping namespaces cannot be safely added together.".into());Ok(result)
                }
                _=>Err(AppError::InvalidInput("Unsupported import format".into())),
            }
        })();
        match &outcome {
            Ok(result)=>db.unified_usage_finish_sync(&run,"success",result.imported,None)?,
            Err(error)=>db.unified_usage_finish_sync(&run,"error",0,Some(&error.to_string()))?,
        }
        outcome
    }).await
}

#[tauri::command]
pub async fn unified_usage_export(state: State<'_, AppState>, path: PathBuf) -> Result<(), String> {
    db_task(&state, move |db| {
        let backup = db.unified_usage_export()?;
        let encoded =
            serde_json::to_vec_pretty(&backup).map_err(|e| AppError::Config(e.to_string()))?;
        crate::config::atomic_write(&path, &encoded)
    })
    .await
}
