//! Verification harness compiling the exact production analytics source without
//! Tauri's MSVC/WebView build requirements. Stubs provide only DB/error plumbing.
pub mod error {
    #[derive(Debug, thiserror::Error)]
    pub enum AppError {
        #[error("Invalid input: {0}")]
        InvalidInput(String),
        #[error("Configuration: {0}")]
        Config(String),
        #[error("Database: {0}")]
        Database(String),
        #[error("{0}")]
        Message(String),
    }
    impl From<rusqlite::Error> for AppError {
        fn from(error: rusqlite::Error) -> Self {
            Self::Database(error.to_string())
        }
    }
}

pub mod database {
    use crate::error::AppError;
    use rusqlite::Connection;
    use std::sync::Mutex;
    pub struct Database {
        pub(crate) conn: Mutex<Connection>,
    }
    macro_rules! lock_conn {
        ($mutex:expr) => {
            $mutex
                .lock()
                .map_err(|e| crate::error::AppError::Database(e.to_string()))?
        };
    }
    pub(crate) use lock_conn;
    impl Database {
        pub fn memory() -> Result<Self, AppError> {
            Self::open_connection(Connection::open_in_memory()?)
        }
        pub fn open(path: &std::path::Path) -> Result<Self, AppError> {
            Self::open_connection(Connection::open(path)?)
        }
        fn open_connection(conn: Connection) -> Result<Self, AppError> {
            conn.execute_batch("PRAGMA foreign_keys=ON;")?;
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);",
            )?;
            crate::unified_usage::create_schema(&conn)?;
            crate::unified_usage_thread_store::create_thread_schema(&conn)?;
            let db = Self {
                conn: Mutex::new(conn),
            };
            db.unified_usage_recover_interrupted()?;
            Ok(db)
        }
    }
}

pub mod config {
    pub fn get_app_config_dir() -> std::path::PathBuf {
        std::env::temp_dir().join("cc-switch-usage-core-verification")
    }
}

pub mod commands {
    pub fn detected_tool_command(
        _tool: &str,
        _args: &[&str],
        _timeout: std::time::Duration,
    ) -> Result<std::process::Command, String> {
        Err("Unit test harness forbids launching the user's Codex CLI".into())
    }
}

#[path = "../../../src-tauri/src/services/unified_usage_codex.rs"]
pub mod unified_usage_codex;

#[path = "../../../src-tauri/src/services/unified_updates.rs"]
pub mod unified_updates;

#[path = "../../../src-tauri/src/services/custom_release.rs"]
pub mod custom_release;

#[path = "../../../src-tauri/src/services/unified_usage.rs"]
pub mod unified_usage;

#[path = "../../../src-tauri/src/services/unified_usage_threads.rs"]
pub mod unified_usage_threads;

#[path = "../../../src-tauri/src/services/unified_usage_thread_store.rs"]
pub mod unified_usage_thread_store;

#[path = "../../../src-tauri/src/services/unified_usage_sync.rs"]
pub mod unified_usage_sync;

#[path = "../../../src-tauri/src/services/quiet_codex.rs"]
pub mod quiet_codex;

pub mod services {
    pub use crate::quiet_codex;
    pub use crate::unified_usage_sync;
    pub use crate::unified_usage_thread_store;
    pub use crate::unified_usage_threads;
}

#[cfg(test)]
mod persistence_tests {
    use crate::{database::Database, error::AppError, unified_usage::*};
    use serde_json::json;

    #[test]
    fn removed_source_exclusion_survives_restart_without_touching_original_accounts(
    ) -> Result<(), AppError> {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("usage.sqlite");
        let sources = vec![
            ExistingAccountMetadata {
                provider_account_id: "original-A".into(),
                login: "a@example.com".into(),
                reauth_required: false,
            },
            ExistingAccountMetadata {
                provider_account_id: "original-B".into(),
                login: "b@example.com".into(),
                reauth_required: false,
            },
        ];
        let source_snapshot = sources.clone();
        {
            let db = Database::open(&path)?;
            let imported = db.unified_usage_reconcile_existing_accounts(&sources)?;
            let a = imported
                .accounts
                .iter()
                .find(|a| a.linked_account_id.as_deref() == Some("original-A"))
                .unwrap();
            db.unified_usage_remove_account(&a.id)?;
        }
        let db = Database::open(&path)?;
        let auto = db.unified_usage_reconcile_existing_accounts(&sources)?;
        assert_eq!(auto.accounts.len(), 1);
        assert_eq!(
            auto.accounts[0].linked_account_id.as_deref(),
            Some("original-B")
        );
        assert_eq!(sources, source_snapshot);
        let manual = db.unified_usage_import_existing_accounts(&sources)?;
        assert_eq!(manual.imported, 1);
        assert_eq!(manual.accounts.len(), 2);
        assert_eq!(
            db.unified_usage_reconcile_existing_accounts(&sources)?
                .accounts
                .len(),
            2
        );
        Ok(())
    }

    #[test]
    fn restart_preserves_two_accounts_and_recovers_interrupted_sync() -> Result<(), AppError> {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("usage.sqlite");
        let id;
        {
            let db = Database::open(&path)?;
            let a = db.unified_usage_add_account("Account A")?;
            let b = db.unified_usage_add_account("Account B")?;
            id = a.id.clone();
            db.unified_usage_bind_identity(
                &a.id,
                &json!({"type":"chatgpt","email":"a@example.com","planType":"pro"}),
            )?;
            db.unified_usage_bind_identity(
                &b.id,
                &json!({"type":"chatgpt","email":"b@example.com","planType":"pro"}),
            )?;
            for (account, tokens) in [(&a, 100), (&b, 200)] {
                db.unified_usage_apply_official(
                    &account.id,
                    Some(
                        &json!({"dailyUsageBuckets":[{"startDate":"2026-11-01","tokens":tokens}]}),
                    ),
                    None,
                )?;
            }
            db.unified_usage_set_status(&a.id, "reauth_required", Some("Authentication expired"))?;
            db.unified_usage_begin_sync(&b.id, "codex_app_server")?;
        }
        let db = Database::open(&path)?;
        let dashboard = db.unified_usage_dashboard(&AnalyticsFilter::default())?;
        assert_eq!(dashboard.accounts.len(), 2);
        assert_eq!(dashboard.record_count, 2);
        assert_eq!(dashboard.totals.iter().map(|x| x.value).sum::<f64>(), 300.0);
        assert_eq!(dashboard.sync_history[0].status, "interrupted");
        assert_eq!(
            db.unified_usage_account(&id)?.connection_status,
            "reauth_required"
        );
        Ok(())
    }

    #[test]
    fn stale_and_equal_snapshot_watermarks_prevent_old_corrections() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        let usage = json!({"dailyUsageBuckets":[{"startDate":"2026-11-01","tokens":100}]});
        let now = chrono::Utc::now().timestamp_millis();
        let mut row = official_observations(&a.id, Some(&usage), now - 10000)?.remove(0);
        db.unified_usage_import_observations(&a.id, &[row.clone()])?;
        row.observed_at = now;
        assert_eq!(
            db.unified_usage_import_observations(&a.id, &[row.clone()])?
                .skipped,
            1
        );
        row.observed_at = now - 5000;
        row.value = 50.0;
        db.unified_usage_import_observations(&a.id, &[row])?;
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .totals[0]
                .value,
            100.0
        );
        Ok(())
    }

    #[test]
    fn overlapping_events_are_rejected_transactionally() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        let usage = json!({"dailyUsageBuckets":[{"startDate":"2026-11-01","tokens":100}]});
        let mut row =
            official_observations(&a.id, Some(&usage), chrono::Utc::now().timestamp_millis())?
                .remove(0);
        db.unified_usage_import_observations(&a.id, &[row.clone()])?;
        row.granularity = "event".into();
        row.event_id = Some("turn-1".into());
        row.value = 10.0;
        row.model = Some("reported-model".into());
        assert!(db.unified_usage_import_observations(&a.id, &[row]).is_err());
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .record_count,
            1
        );
        Ok(())
    }

    #[test]
    fn filters_and_units_preserve_individual_scope() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        let b = db.unified_usage_add_account("B")?;
        let now = chrono::Utc::now().timestamp_millis();
        let usage = json!({"dailyUsageBuckets":[{"startDate":"2026-11-01","tokens":100},{"startDate":"2026-11-02","tokens":200}]});
        let official = official_observations(&a.id, Some(&usage), now)?;
        db.unified_usage_import_observations(&a.id, &official)?;
        let mut other = official[0].clone();
        other.account_id = b.id.clone();
        other.source = "imported_usage".into();
        other.scope = "imported:images".into();
        other.metric = "images".into();
        other.unit = "images".into();
        other.provenance = "local".into();
        other.value = 3.0;
        db.unified_usage_import_observations(&b.id, &[other])?;
        let filter = AnalyticsFilter {
            start_date: Some("2026-11-02".into()),
            end_date: Some("2026-11-02".into()),
            account_ids: Some(vec![a.id]),
            ..Default::default()
        };
        let dashboard = db.unified_usage_dashboard(&filter)?;
        assert_eq!(dashboard.record_count, 1);
        assert_eq!(dashboard.totals[0].value, 200.0);
        assert_eq!(dashboard.totals[0].unit, "tokens");
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .totals
                .len(),
            2
        );
        Ok(())
    }
}
