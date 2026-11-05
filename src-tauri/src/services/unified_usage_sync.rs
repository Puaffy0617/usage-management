//! Persistent background-sync policy. The native worker owns collection; UI
//! visibility is deliberately absent from this policy and does not stop it.
use super::unified_usage::AnalyticsAccount;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::sync::{Mutex, MutexGuard, Notify};

const SETTINGS_KEY: &str = "unified_usage_background_sync_v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundSyncSettings {
    pub enabled: bool,
    pub interval_minutes: u32,
}

impl Default for BackgroundSyncSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_minutes: 2,
        }
    }
}

impl BackgroundSyncSettings {
    fn validate(&self) -> Result<(), AppError> {
        if ![1, 2, 5].contains(&self.interval_minutes) {
            return Err(AppError::InvalidInput(
                "Background refresh interval must be 1, 2 or 5 minutes".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundAccountSyncStatus {
    pub account_id: String,
    pub running: bool,
    pub last_attempt_at: Option<i64>,
    pub last_finished_at: Option<i64>,
    pub next_due_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSyncStatus {
    pub running: bool,
    pub last_attempt_at: Option<i64>,
    pub last_finished_at: Option<i64>,
    pub next_due_at: Option<i64>,
    pub accounts: Vec<BackgroundAccountSyncStatus>,
}

#[derive(Default)]
struct Timing {
    attempt: Option<i64>,
    finished: Option<i64>,
    running: bool,
}

fn settings_on_conn(conn: &Connection) -> Result<BackgroundSyncSettings, AppError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let settings = match raw {
        Some(value) => serde_json::from_str(&value).map_err(|_| {
            AppError::Config(
                "Background refresh preferences are invalid; automatic synchronization stopped"
                    .into(),
            )
        })?,
        None => BackgroundSyncSettings::default(),
    };
    settings.validate()?;
    Ok(settings)
}

fn timing_on_conn(conn: &Connection, id: &str) -> Result<Timing, AppError> {
    Ok(conn.query_row("SELECT MAX(started_at),MAX(finished_at),COALESCE(MAX(CASE WHEN status='running' THEN 1 ELSE 0 END),0) FROM unified_usage_sync_runs WHERE account_id=?1 AND source='codex_app_server'",[id],|row|Ok(Timing {attempt:row.get(0)?,finished:row.get(1)?,running:row.get::<_,i64>(2)?!=0}))?)
}

fn save_settings_on_conn(
    conn: &Connection,
    settings: BackgroundSyncSettings,
) -> Result<BackgroundSyncSettings, AppError> {
    settings.validate()?;
    let raw = serde_json::to_string(&settings)
        .map_err(|_| AppError::Config("Cannot save background refresh preferences".into()))?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![SETTINGS_KEY,raw])?;
    Ok(settings)
}

fn next_due(
    settings: &BackgroundSyncSettings,
    status: &str,
    has_identity: bool,
    override_minutes: u32,
    last_sync_at: Option<i64>,
    timing: &Timing,
    now: i64,
) -> Option<i64> {
    if !settings.enabled
        || !has_identity
        || !["connected", "error"].contains(&status)
        || timing.running
    {
        return None;
    }
    let minutes = if (5..=1440).contains(&override_minutes) {
        override_minutes
    } else {
        settings.interval_minutes
    };
    let baseline = [last_sync_at, timing.attempt, timing.finished]
        .into_iter()
        .flatten()
        .max();
    Some(baseline.map_or(now, |value| {
        value.saturating_add(i64::from(minutes) * 60_000)
    }))
}

impl Database {
    pub fn unified_usage_get_sync_settings(&self) -> Result<BackgroundSyncSettings, AppError> {
        let conn = lock_conn!(self.conn);
        settings_on_conn(&conn)
    }

    pub fn unified_usage_set_sync_settings(
        &self,
        settings: BackgroundSyncSettings,
    ) -> Result<BackgroundSyncSettings, AppError> {
        let conn = lock_conn!(self.conn);
        save_settings_on_conn(&conn, settings)
    }

    /// Rechecked after taking the existing profile lock, immediately before any
    /// authentication/network action. Settings changes and manual runs win races.
    pub fn unified_usage_sync_account_due(
        &self,
        account: &AnalyticsAccount,
        now: i64,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let settings = settings_on_conn(&conn)?;
        let timing = timing_on_conn(&conn, &account.id)?;
        Ok(next_due(
            &settings,
            &account.connection_status,
            account.identity.is_some(),
            account.sync_interval_minutes,
            account.last_sync_at,
            &timing,
            now,
        )
        .is_some_and(|due| due <= now))
    }

    pub fn unified_usage_sync_status(&self, now: i64) -> Result<BackgroundSyncStatus, AppError> {
        let conn = lock_conn!(self.conn);
        let settings = settings_on_conn(&conn)?;
        let mut stmt=conn.prepare("SELECT id,connection_status,identity,sync_interval_minutes,last_sync_at FROM unified_usage_accounts ORDER BY created_at,id")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })?;
        let mut accounts = Vec::new();
        for row in rows {
            let (id, status, identity, interval, last_sync) = row?;
            let timing = timing_on_conn(&conn, &id)?;
            accounts.push(BackgroundAccountSyncStatus {
                account_id: id,
                running: timing.running,
                last_attempt_at: timing.attempt,
                last_finished_at: timing.finished,
                next_due_at: next_due(
                    &settings,
                    &status,
                    identity.is_some(),
                    interval,
                    last_sync,
                    &timing,
                    now,
                ),
            });
        }
        Ok(BackgroundSyncStatus {
            running: accounts.iter().any(|row| row.running),
            last_attempt_at: accounts.iter().filter_map(|row| row.last_attempt_at).max(),
            last_finished_at: accounts.iter().filter_map(|row| row.last_finished_at).max(),
            next_due_at: accounts.iter().filter_map(|row| row.next_due_at).min(),
            accounts,
        })
    }
}

/// Shared by manual sync and the one native worker; a busy batch is observed,
/// never queued as another duplicate batch. Profile locks still guard lifecycle.
#[derive(Default)]
pub struct SyncCoordinator {
    gate: Mutex<()>,
    started: AtomicBool,
    wake: Notify,
}

impl SyncCoordinator {
    pub fn try_begin(&self) -> Option<MutexGuard<'_, ()>> {
        self.gate.try_lock().ok()
    }
    pub fn is_running(&self) -> bool {
        self.gate.try_lock().is_err()
    }
    pub fn start_once(&self) -> bool {
        !self.started.swap(true, Ordering::SeqCst)
    }
    pub fn wake(&self) {
        self.wake.notify_one();
    }
    pub async fn notified(&self) {
        self.wake.notified().await;
    }
}

pub fn sync_coordinator() -> &'static SyncCoordinator {
    static RUNTIME: OnceLock<SyncCoordinator> = OnceLock::new();
    RUNTIME.get_or_init(SyncCoordinator::default)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connected(db: &Database, name: &str) -> AnalyticsAccount {
        let account = db.unified_usage_add_account(name).unwrap();
        db.unified_usage_bind_identity(&account.id,&serde_json::json!({"type":"chatgpt","email":format!("{name}@fixture.test"),"planType":"pro"})).unwrap();
        db.unified_usage_account(&account.id).unwrap()
    }

    #[test]
    fn defaults_follow_global_and_persist_across_a_database_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)", [])
            .unwrap();
        assert_eq!(
            settings_on_conn(&db).unwrap(),
            BackgroundSyncSettings::default()
        );
        save_settings_on_conn(
            &db,
            BackgroundSyncSettings {
                enabled: false,
                interval_minutes: 5,
            },
        )
        .unwrap();
        drop(db);
        assert_eq!(
            settings_on_conn(&Connection::open(&path).unwrap()).unwrap(),
            BackgroundSyncSettings {
                enabled: false,
                interval_minutes: 5
            }
        );
    }

    #[test]
    fn all_accounts_follow_global_without_any_page_or_focus_dependency() {
        let db = Database::memory().unwrap();
        let a = connected(&db, "a");
        let b = connected(&db, "b");
        let status = db.unified_usage_sync_status(1000).unwrap();
        assert_eq!(status.accounts.len(), 2);
        assert!(status
            .accounts
            .iter()
            .all(|row| row.next_due_at == Some(1000)));
        assert!(db.unified_usage_sync_account_due(&a, 1000).unwrap());
        assert!(db.unified_usage_sync_account_due(&b, 1000).unwrap());
        db.unified_usage_set_sync_settings(BackgroundSyncSettings {
            enabled: false,
            interval_minutes: 2,
        })
        .unwrap();
        assert!(db
            .unified_usage_sync_status(1000)
            .unwrap()
            .accounts
            .iter()
            .all(|row| row.next_due_at.is_none()));
    }

    #[test]
    fn failures_wait_from_finished_attempt_and_legacy_overrides_remain_effective() {
        let db = Database::memory().unwrap();
        let mut account = connected(&db, "a");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO unified_usage_sync_runs(id,account_id,source,started_at,finished_at,status) VALUES('failed',?1,'codex_app_server',1000,5000,'error')",[&account.id]).unwrap();
        }
        assert!(!db.unified_usage_sync_account_due(&account, 124999).unwrap());
        assert!(db.unified_usage_sync_account_due(&account, 125000).unwrap());
        account = db
            .unified_usage_update_account(&account.id, "A", 5)
            .unwrap();
        assert!(!db.unified_usage_sync_account_due(&account, 125000).unwrap());
        assert!(db.unified_usage_sync_account_due(&account, 305000).unwrap());
    }

    #[test]
    fn disabled_or_reauthentication_profiles_never_retry_automatically() {
        let db = Database::memory().unwrap();
        let mut account = connected(&db, "a");
        for status in ["disconnected", "pending", "reauth_required", "unsupported"] {
            account.connection_status = status.into();
            assert!(!db
                .unified_usage_sync_account_due(&account, 1_000_000)
                .unwrap());
        }
        account.connection_status = "connected".into();
        account.identity = None;
        assert!(!db
            .unified_usage_sync_account_due(&account, 1_000_000)
            .unwrap());
    }

    #[test]
    fn active_runs_and_recent_manual_runs_prevent_a_second_automatic_attempt() {
        let db = Database::memory().unwrap();
        let account = connected(&db, "a");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO unified_usage_sync_runs(id,account_id,source,started_at,status) VALUES('active',?1,'codex_app_server',1000,'running')",[&account.id]).unwrap();
        }
        assert!(!db
            .unified_usage_sync_account_due(&account, 1_000_000)
            .unwrap());
        assert!(db.unified_usage_sync_status(2000).unwrap().running);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE unified_usage_sync_runs SET status='success',finished_at=2000",
                [],
            )
            .unwrap();
        }
        assert!(!db.unified_usage_sync_account_due(&account, 121999).unwrap());
        assert!(db.unified_usage_sync_account_due(&account, 122000).unwrap());
    }

    #[test]
    fn invalid_persisted_preferences_fail_closed_without_silent_enablement() {
        let db = Database::memory().unwrap();
        assert!(db
            .unified_usage_set_sync_settings(BackgroundSyncSettings {
                enabled: true,
                interval_minutes: 3
            })
            .is_err());
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings(key,value) VALUES(?1,'broken')",
                [SETTINGS_KEY],
            )
            .unwrap();
        }
        assert!(db.unified_usage_get_sync_settings().is_err());
        assert!(db.unified_usage_sync_status(1000).is_err());
    }

    #[tokio::test]
    async fn one_worker_and_one_manual_or_background_batch_can_own_collection() {
        let runtime = SyncCoordinator::default();
        assert!(runtime.start_once());
        assert!(!runtime.start_once());
        let first = runtime.try_begin().unwrap();
        assert!(runtime.is_running());
        assert!(runtime.try_begin().is_none());
        drop(first);
        assert!(!runtime.is_running());
        assert!(runtime.try_begin().is_some());
        runtime.wake();
        tokio::time::timeout(std::time::Duration::from_millis(50), runtime.notified())
            .await
            .unwrap();
    }
}
