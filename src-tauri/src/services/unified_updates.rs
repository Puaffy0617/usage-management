//! Device-local preparation of feature-preserving custom updates. Upstream
//! releases are advisory inputs, never directly installed by this edition.
use chrono::Utc;
use once_cell::sync::Lazy;
#[cfg(not(test))]
use process_wrap::tokio::{KillOnDrop, TokioCommandWrap};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::process::Stdio;
#[cfg(not(test))]
use std::time::Duration;
#[cfg(not(test))]
use tokio::process::Command;
use tokio::sync::Mutex;

pub const EDITION: &str = "cc-switch-unified-usage";
const MAX_STATE_BYTES: u64 = 64 * 1024;
const MAX_RESULT_BYTES: u64 = 256 * 1024;
#[cfg(not(test))]
const MAX_JOB_TIME: Duration = Duration::from_secs(90 * 60);
const PHASES: &[&str] = &[
    "not_configured",
    "idle",
    "preparing",
    "ready",
    "conflict",
    "migration_review",
    "error",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedUpdateStatus {
    pub edition: String,
    pub upstream_version: String,
    pub source_dir: Option<String>,
    pub auto_prepare: bool,
    pub phase: String,
    pub target_version: Option<String>,
    pub candidate_dir: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalState {
    source_dir: Option<String>,
    #[serde(default)]
    auto_prepare: bool,
    #[serde(default = "not_configured")]
    phase: String,
    target_version: Option<String>,
    candidate_dir: Option<String>,
    error: Option<String>,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    job_id: Option<String>,
}

fn not_configured() -> String {
    "not_configured".into()
}

impl LocalState {
    fn fresh() -> Self {
        Self {
            phase: not_configured(),
            ..Default::default()
        }
    }
    fn status(&self) -> UnifiedUpdateStatus {
        UnifiedUpdateStatus {
            edition: EDITION.into(),
            upstream_version: upstream_baseline(),
            source_dir: self.source_dir.clone(),
            auto_prepare: self.auto_prepare,
            phase: self.phase.clone(),
            target_version: self.target_version.clone(),
            candidate_dir: self.candidate_dir.clone(),
            error: self.error.clone(),
            started_at: self.started_at,
            finished_at: self.finished_at,
        }
    }
}

fn upstream_baseline() -> String {
    serde_json::from_str::<Value>(include_str!("../../../customization/upstream.json"))
        .ok()
        .and_then(|manifest| {
            manifest
                .get("upstreamVersion")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|version| normalize_version(version).is_ok())
        .unwrap_or_else(|| "unknown".into())
}

static STATES: Lazy<Mutex<HashMap<PathBuf, LocalState>>> = Lazy::new(|| Mutex::new(HashMap::new()));
#[cfg(test)]
static TEST_ROOT: Lazy<tempfile::TempDir> =
    Lazy::new(|| tempfile::tempdir().expect("isolated update-policy test directory"));

fn state_root() -> PathBuf {
    #[cfg(not(test))]
    {
        crate::config::get_app_config_dir().join("unified-updates")
    }
    #[cfg(test)]
    {
        TEST_ROOT.path().to_path_buf()
    }
}

fn jobs_root() -> PathBuf {
    #[cfg(not(test))]
    {
        dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("cc-switch-unified-updates")
            .join("jobs")
    }
    #[cfg(test)]
    {
        TEST_ROOT.path().join("jobs")
    }
}

/// There is no configured signed custom distribution channel. Keeping this
/// unconditional also protects old UI/native entry points from stock replacement.
pub fn require_feature_preserving_update() -> Result<(), String> {
    Err("This custom edition cannot install stock CC Switch updates because they would remove account analytics. Open Settings → About → Custom updates to prepare a merged, tested custom build. The running application and existing accounts remain unchanged.".into())
}

fn bounded_json(path: &Path, limit: u64) -> Result<Value, String> {
    use std::io::Read;
    let file = std::fs::File::open(path)
        .map_err(|_| "Cannot read the custom update metadata file".to_owned())?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect the custom update metadata file")?
        .len()
        > limit
    {
        return Err("The custom update metadata file is too large".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read custom update metadata")?;
    if bytes.len() as u64 > limit {
        return Err("The custom update metadata file is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "The custom update metadata JSON is invalid".into())
}

pub fn normalize_version(raw: &str) -> Result<String, String> {
    let version = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    if version.len() > 96
        || version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
    {
        return Err("Use a valid upstream release version such as 4.0.26".into());
    }
    let (release, build) = version
        .split_once('+')
        .map_or((version, None), |(a, b)| (a, Some(b)));
    let (core, prerelease) = release
        .split_once('-')
        .map_or((release, None), |(a, b)| (a, Some(b)));
    let parts = core.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|p| {
            p.is_empty() || p.parse::<u64>().is_err() || (p.len() > 1 && p.starts_with('0'))
        })
    {
        return Err("Use a three-part upstream release version".into());
    }
    let valid_identifiers = |suffix: &str, prerelease: bool| {
        suffix.split('.').all(|part| {
            !part.is_empty()
                && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                && !(prerelease
                    && part.chars().all(|c| c.is_ascii_digit())
                    && part.len() > 1
                    && part.starts_with('0'))
        })
    };
    if build.is_some_and(|s| !valid_identifiers(s, false))
        || prerelease.is_some_and(|s| !valid_identifiers(s, true))
    {
        return Err("The upstream release version suffix is invalid".into());
    }
    Ok(version.into())
}

fn validate_source_dir(raw: &str) -> Result<PathBuf, String> {
    let source = Path::new(raw)
        .canonicalize()
        .map_err(|_| "Choose the extracted custom CC Switch source directory".to_owned())?;
    if !source.is_dir() {
        return Err("The source path must be a directory".into());
    }
    let manifest_path = source.join("customization/upstream.json");
    let manifest_file = manifest_path.canonicalize().map_err(|_| {
        "This source directory has no customization/upstream.json manifest".to_owned()
    })?;
    let script = source
        .join("scripts/maintain-upstream.mjs")
        .canonicalize()
        .map_err(|_| "This source directory has no maintenance script".to_owned())?;
    if !manifest_file.starts_with(&source) || !script.starts_with(&source) || !script.is_file() {
        return Err("Custom update files must stay inside the chosen source directory".into());
    }
    let manifest = bounded_json(&manifest_file, MAX_STATE_BYTES)?;
    if manifest.get("edition").and_then(Value::as_str) != Some(EDITION) {
        return Err("The source directory belongs to a different application edition".into());
    }
    Ok(source)
}

fn save_state(root: &Path, state: &LocalState) -> Result<(), String> {
    std::fs::create_dir_all(root)
        .map_err(|_| "Cannot create device-local custom update settings")?;
    let bytes =
        serde_json::to_vec_pretty(state).map_err(|_| "Cannot encode custom update settings")?;
    let temporary = root.join(format!("state-{}.tmp", uuid::Uuid::new_v4()));
    use std::io::Write;
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "Cannot write device-local update settings")?;
        file.write_all(&bytes)
            .map_err(|_| "Cannot write device-local update settings")?;
        file.sync_all()
            .map_err(|_| "Cannot flush device-local update settings")?;
        std::fs::rename(&temporary, root.join("state.json"))
            .map_err(|_| "Cannot replace device-local update settings")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn load_state(root: &Path) -> Result<LocalState, String> {
    let path = root.join("state.json");
    if !path
        .try_exists()
        .map_err(|_| "Cannot inspect device-local update settings")?
    {
        return Ok(LocalState::fresh());
    }
    let value = bounded_json(&path, MAX_STATE_BYTES)?;
    let mut state: LocalState = serde_json::from_value(value)
        .map_err(|_| "Device-local custom update settings are invalid".to_owned())?;
    if !PHASES.contains(&state.phase.as_str()) {
        return Err("Saved custom update phase is invalid".into());
    }
    if state.phase == "preparing" {
        state.phase = "error".into();
        state.finished_at = Some(Utc::now().timestamp_millis());
        state.error=Some("The application stopped before preparation finished. The installed version was not replaced; prepare the custom update again.".into());
        save_state(root, &state)?;
    }
    Ok(state)
}

fn cached<'a>(
    states: &'a mut HashMap<PathBuf, LocalState>,
    root: &Path,
) -> Result<&'a mut LocalState, String> {
    if !states.contains_key(root) {
        states.insert(root.to_path_buf(), load_state(root)?);
    }
    states
        .get_mut(root)
        .ok_or_else(|| "Cannot load custom update state".into())
}

fn ensure_no_running_job(states: &HashMap<PathBuf, LocalState>) -> Result<(), String> {
    if states.values().any(|state| state.phase == "preparing") {
        return Err("A custom update is already being prepared; wait for it to finish".into());
    }
    Ok(())
}

fn source_for_prepare(state: &LocalState) -> Result<String, String> {
    state.source_dir.clone().ok_or_else(|| {
        "Choose a custom source directory in Settings → About before preparing an update".into()
    })
}

pub async fn status() -> Result<UnifiedUpdateStatus, String> {
    let root = state_root();
    let mut states = STATES.lock().await;
    Ok(cached(&mut states, &root)?.status())
}

pub async fn configure(
    source_dir: Option<String>,
    auto_prepare: bool,
) -> Result<UnifiedUpdateStatus, String> {
    let source = match source_dir.filter(|s| !s.trim().is_empty()) {
        Some(raw) => Some(
            tokio::task::spawn_blocking(move || validate_source_dir(&raw))
                .await
                .map_err(|_| "Cannot validate the source directory")??,
        ),
        None => None,
    };
    let root = state_root();
    let mut states = STATES.lock().await;
    let previous = cached(&mut states, &root)?.clone();
    ensure_no_running_job(&states)?;
    let mut next = LocalState::fresh();
    next.source_dir = source.map(|p| p.to_string_lossy().into_owned());
    next.auto_prepare = auto_prepare && next.source_dir.is_some();
    next.phase = if next.source_dir.is_some() {
        "idle"
    } else {
        "not_configured"
    }
    .into();
    next.target_version = previous.target_version;
    save_state(&root, &next)?;
    let status = next.status();
    states.insert(root, next);
    Ok(status)
}

pub async fn on_upstream_available(version: String) -> Result<UnifiedUpdateStatus, String> {
    let version = normalize_version(&version)?;
    let root = state_root();
    let auto = {
        let mut states = STATES.lock().await;
        let state = cached(&mut states, &root)?;
        if state.phase == "preparing" {
            return Ok(state.status());
        }
        let already_processed = state.target_version.as_deref() == Some(&version)
            && ["ready", "conflict", "migration_review", "error"].contains(&state.phase.as_str());
        if state.target_version.as_deref() != Some(&version) {
            state.phase = if state.source_dir.is_some() {
                "idle"
            } else {
                "not_configured"
            }
            .into();
            state.candidate_dir = None;
            state.error = None;
            state.started_at = None;
            state.finished_at = None;
            state.job_id = None;
        }
        state.target_version = Some(version.clone());
        save_state(&root, state)?;
        let should_prepare = state.auto_prepare && state.source_dir.is_some() && !already_processed;
        if !should_prepare {
            return Ok(state.status());
        }
        should_prepare
    };
    if auto {
        prepare(version).await
    } else {
        status().await
    }
}

pub async fn prepare(target_version: String) -> Result<UnifiedUpdateStatus, String> {
    let target = normalize_version(&target_version)?;
    let root = state_root();
    let source = {
        let mut states = STATES.lock().await;
        source_for_prepare(cached(&mut states, &root)?)?
    };
    let source = tokio::task::spawn_blocking(move || validate_source_dir(&source))
        .await
        .map_err(|_| "Cannot validate the source directory")??;
    let job_id = uuid::Uuid::new_v4().to_string();
    let job_dir = {
        let mut states = STATES.lock().await;
        ensure_no_running_job(&states)?;
        let state = cached(&mut states, &root)?;
        if state.source_dir.as_deref() != Some(source.to_string_lossy().as_ref()) {
            return Err("The source setting changed; retry preparation".into());
        }
        let jobs = jobs_root();
        std::fs::create_dir_all(&jobs)
            .map_err(|_| "Cannot create the custom update job directory")?;
        let jobs = jobs
            .canonicalize()
            .map_err(|_| "Cannot resolve the custom update job directory")?;
        let job = jobs.join(&job_id);
        std::fs::create_dir(&job).map_err(|_| "Cannot create this custom update job")?;
        let job = job
            .canonicalize()
            .map_err(|_| "Cannot resolve this custom update job")?;
        if job.parent() != Some(jobs.as_path()) || job.starts_with(&source) {
            return Err("Update jobs must stay outside the source directory".into());
        }
        state.phase = "preparing".into();
        state.target_version = Some(target.clone());
        state.candidate_dir = None;
        state.error = None;
        state.started_at = Some(Utc::now().timestamp_millis());
        state.finished_at = None;
        state.job_id = Some(job_id.clone());
        save_state(&root, state)?;
        job
    };
    let return_status = {
        let mut states = STATES.lock().await;
        cached(&mut states, &root)?.status()
    };
    tokio::spawn(async move {
        let outcome = run_pipeline(&source, &job_dir, &target).await;
        let mut states = STATES.lock().await;
        if let Ok(state) = cached(&mut states, &root) {
            if state.job_id.as_deref() != Some(&job_id) {
                return;
            }
            match outcome {
                Ok(result) => {
                    state.phase = result.phase;
                    state.candidate_dir = result.candidate_dir;
                    state.error = result.error;
                }
                Err(error) => {
                    state.phase = "error".into();
                    state.error = Some(error.chars().take(2048).collect());
                    state.candidate_dir = job_dir
                        .canonicalize()
                        .ok()
                        .filter(|path| path == &job_dir)
                        .map(|path| path.to_string_lossy().into_owned());
                }
            }
            state.finished_at = Some(Utc::now().timestamp_millis());
            if let Err(error) = save_state(&root, state) {
                state.phase = "error".into();
                state.error = Some(error);
            }
        }
    });
    Ok(return_status)
}

#[derive(Debug)]
struct PipelineResult {
    phase: String,
    candidate_dir: Option<String>,
    error: Option<String>,
}

fn read_pipeline_result(
    job: &Path,
    target: &str,
    process_succeeded: bool,
) -> Result<PipelineResult, String> {
    let result_path=job.join("result.json").canonicalize().map_err(|_|"Maintenance stopped without a result report; check that Node.js, Git, pnpm and the native build toolchain are installed".to_owned())?;
    let job = job
        .canonicalize()
        .map_err(|_| "Cannot resolve the maintenance job")?;
    if !result_path.starts_with(&job) {
        return Err("Maintenance result must stay inside its job directory".into());
    }
    let result = bounded_json(&result_path, MAX_RESULT_BYTES)?;
    let phase = result
        .get("phase")
        .and_then(Value::as_str)
        .ok_or("Maintenance result has no phase")?;
    if !["ready", "conflict", "migration_review", "error"].contains(&phase) {
        return Err("Maintenance result has an invalid phase".into());
    }
    if result
        .get("targetVersion")
        .and_then(Value::as_str)
        .map(normalize_version)
        .transpose()?
        .as_deref()
        != Some(target)
    {
        return Err("Maintenance result belongs to another upstream version".into());
    }
    if phase == "ready" && !process_succeeded {
        return Err(
            "The maintenance process failed; its candidate cannot be treated as ready".into(),
        );
    }
    if phase == "ready"
        && (result.get("built").and_then(Value::as_bool) != Some(true)
            || result
                .pointer("/nativeBuild/passed")
                .and_then(Value::as_bool)
                != Some(true)
            || result
                .get("checks")
                .and_then(Value::as_array)
                .is_none_or(|checks| {
                    checks.is_empty()
                        || checks
                            .iter()
                            .any(|check| check.get("passed").and_then(Value::as_bool) != Some(true))
                }))
    {
        return Err("The candidate has not passed all mandatory checks and a native build".into());
    }
    let candidate = result
        .get("candidateDir")
        .and_then(Value::as_str)
        .map(|path| {
            let candidate = Path::new(path)
                .canonicalize()
                .map_err(|_| "The prepared candidate directory is missing")?;
            if !candidate.is_dir() || !candidate.starts_with(&job) {
                return Err("The prepared candidate must stay inside its job directory");
            }
            Ok(candidate.to_string_lossy().into_owned())
        })
        .transpose()
        .map_err(str::to_owned)?;
    if phase == "ready" && candidate.is_none() {
        return Err("A ready maintenance result must include its candidate directory".into());
    }
    let error = result
        .get("error")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(2048).collect());
    Ok(PipelineResult {
        phase: phase.into(),
        // The UI opens the job workspace containing ZIPs, validation reports and
        // the source candidate. result.json retains the precise source path.
        candidate_dir: Some(job.to_string_lossy().into_owned()),
        error,
    })
}

async fn run_pipeline(source: &Path, job: &Path, target: &str) -> Result<PipelineResult, String> {
    #[cfg(test)]
    {
        let _ = (source, job, target);
        return Err("Unit tests forbid launching the maintenance pipeline".into());
    }
    #[cfg(not(test))]
    {
        let mut command = Command::new("node");
        command
            .arg(source.join("scripts/maintain-upstream.mjs"))
            .args(["--target-version", target, "--output"])
            .arg(job)
            .arg("--build")
            .current_dir(source)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for key in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "CODEX_API_KEY",
            "CHATGPT_TOKEN",
            "CODEX_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
            "NODE_OPTIONS",
            "NODE_PATH",
            "CODEX_HOME",
            "TAURI_CONFIG",
        ] {
            command.env_remove(key);
        }
        let test_home = job.join("test-home");
        command.env("CC_SWITCH_TEST_HOME", test_home);
        let mut command = TokioCommandWrap::from(command);
        command.wrap(KillOnDrop);
        #[cfg(unix)]
        command.wrap(process_wrap::tokio::ProcessGroup::leader());
        #[cfg(windows)]
        {
            let mut flags = process_wrap::tokio::CreationFlags(Default::default());
            flags.0 .0 = 0x08000000;
            command.wrap(flags).wrap(process_wrap::tokio::JobObject);
        }
        let mut child=command.spawn().map_err(|_|"Cannot start Node.js for custom update preparation; install Node.js and add it to PATH".to_owned())?;
        let waited = tokio::time::timeout(MAX_JOB_TIME, Box::into_pin(child.wait())).await;
        let status = match waited {
            Ok(result) => result.map_err(|_| "Cannot wait for the custom update job")?,
            Err(_) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(10), Box::into_pin(child.wait()))
                    .await;
                return Err("Custom update preparation exceeded 90 minutes and was stopped. The installed application was not changed.".into());
            }
        };
        read_pipeline_result(job, target, status.success())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_and_stock_install_policy_are_strict() {
        assert_eq!(normalize_version("v4.0.26").unwrap(), "4.0.26");
        for invalid in [
            "--help",
            "4.1",
            "4.0.26;whoami",
            "4.0.26/../x",
            "01.0.0",
            "4.0.26+",
            "4.0.26-01",
            "4.0.26-rc..1",
            "4.0.26+one+two",
        ] {
            assert!(normalize_version(invalid).is_err());
        }
        assert!(require_feature_preserving_update().is_err());
    }

    #[test]
    fn source_requires_custom_edition_and_pipeline() {
        let root = tempfile::tempdir().unwrap();
        assert!(validate_source_dir(root.path().to_str().unwrap()).is_err());
        std::fs::create_dir(root.path().join("customization")).unwrap();
        std::fs::create_dir(root.path().join("scripts")).unwrap();
        std::fs::write(
            root.path().join("scripts/maintain-upstream.mjs"),
            "// fixture, never executed",
        )
        .unwrap();
        std::fs::write(
            root.path().join("customization/upstream.json"),
            json!({"edition":"stock"}).to_string(),
        )
        .unwrap();
        assert!(validate_source_dir(root.path().to_str().unwrap()).is_err());
        std::fs::write(
            root.path().join("customization/upstream.json"),
            json!({"edition":EDITION}).to_string(),
        )
        .unwrap();
        assert_eq!(
            validate_source_dir(root.path().to_str().unwrap()).unwrap(),
            root.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn persisted_interruption_is_recoverable_and_only_one_job_is_allowed() {
        let root = tempfile::tempdir().unwrap();
        let mut state = LocalState::fresh();
        state.phase = "preparing".into();
        state.target_version = Some("4.0.26".into());
        save_state(root.path(), &state).unwrap();
        let recovered = load_state(root.path()).unwrap();
        assert_eq!(recovered.phase, "error");
        assert!(recovered.finished_at.is_some());
        let mut states = HashMap::new();
        states.insert(root.path().into(), state);
        assert!(ensure_no_running_job(&states).is_err());
        states.values_mut().next().unwrap().phase = "ready".into();
        assert!(ensure_no_running_job(&states).is_ok());
    }

    #[test]
    fn result_cannot_escape_job_or_claim_ready_after_failed_process() {
        let job = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let report = |candidate: &Path, phase: &str| {
            std::fs::write(job.path().join("result.json"),json!({"phase":phase,"targetVersion":"4.0.26","candidateDir":candidate,"error":null,"built":true,"nativeBuild":{"passed":true},"checks":[{"name":"fixture check","passed":true}]}).to_string()).unwrap()
        };
        report(outside.path(), "ready");
        assert!(read_pipeline_result(job.path(), "4.0.26", true).is_err());
        let candidate = job.path().join("candidate");
        std::fs::create_dir(&candidate).unwrap();
        report(&candidate, "ready");
        assert!(read_pipeline_result(job.path(), "4.0.26", false).is_err());
        assert_eq!(
            read_pipeline_result(job.path(), "4.0.26", true)
                .unwrap()
                .phase,
            "ready"
        );
        assert!(read_pipeline_result(job.path(), "4.0.27", true).is_err());
        std::fs::write(job.path().join("result.json"),json!({"phase":"ready","targetVersion":"4.0.26","candidateDir":candidate,"built":false,"nativeBuild":{"passed":true},"checks":[{"passed":true}]}).to_string()).unwrap();
        assert!(read_pipeline_result(job.path(), "4.0.26", true).is_err());
        report(&candidate, "migration_review");
        assert_eq!(
            read_pipeline_result(job.path(), "4.0.26", false)
                .unwrap()
                .phase,
            "migration_review"
        );
    }

    #[tokio::test]
    async fn no_config_is_advisory_and_never_launches_a_job() {
        let state = LocalState::fresh();
        assert_eq!(state.phase, "not_configured");
        assert!(!state.auto_prepare);
        assert!(state.source_dir.is_none());
        assert!(source_for_prepare(&state).is_err());
        configure(None, false).await.unwrap();
        let advisory = on_upstream_available("v4.0.26".into()).await.unwrap();
        assert_eq!(advisory.phase, "not_configured");
        assert_eq!(advisory.target_version.as_deref(), Some("4.0.26"));
        assert!(!advisory.auto_prepare);
        assert!(prepare("4.0.26".into()).await.is_err());
        let root = tempfile::tempdir().unwrap();
        let outcome = run_pipeline(root.path(), root.path(), "4.0.26").await;
        assert!(outcome.unwrap_err().contains("forbid"));
    }
}
