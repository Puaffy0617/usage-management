//! Account-level analytics. Metrics with different scope, units, or provenance are
//! deliberately never merged. Consumer ChatGPT completeness is not inferred.
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};

pub const MAX_IMPORT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SAFE_VALUE: f64 = 9_007_199_254_740_991.0;
const EXCLUDED_SOURCE_IDS_KEY: &str = "unified_usage_excluded_source_ids_v1";

fn excluded_source_ids(conn: &Connection) -> Result<BTreeSet<String>, AppError> {
    let raw: Option<Option<String>> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [EXCLUDED_SOURCE_IDS_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw.flatten() else {
        return Ok(BTreeSet::new());
    };
    let ids:BTreeSet<String>=serde_json::from_str(&raw).map_err(|_|AppError::Config("Analytics discovery exclusions are invalid; automatic discovery stopped to preserve removed accounts".into()))?;
    if ids.len() > 100_000 || ids.iter().any(|id| id.trim().is_empty() || id.len() > 512) {
        return Err(AppError::Config(
            "Analytics discovery exclusions contain invalid source IDs".into(),
        ));
    }
    Ok(ids)
}

fn save_excluded_source_ids(conn: &Connection, ids: &BTreeSet<String>) -> Result<(), AppError> {
    let encoded = serde_json::to_string(ids).map_err(|e| AppError::Config(e.to_string()))?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![EXCLUDED_SOURCE_IDS_KEY,encoded])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalyticsAccount {
    pub id: String,
    pub name: String,
    pub identity: Option<String>,
    pub subscription: Option<String>,
    pub connection_status: String,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub sync_interval_minutes: u32,
    pub summary: Option<Value>,
    pub quota: Option<Value>,
    pub quota_updated_at: Option<i64>,
    pub created_at: i64,
    /// Nonsecret link to this installation's original CC Switch account manager.
    /// Backups deliberately omit it and restore never recreates authentication links.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_account_id: Option<String>,
}

/// Metadata-only input: this type cannot carry any credential material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingAccountMetadata {
    pub provider_account_id: String,
    pub login: String,
    pub reauth_required: bool,
}

#[derive(Serialize)]
pub struct ExistingAccountsImportResult {
    pub imported: u64,
    pub skipped: u64,
    pub accounts: Vec<AnalyticsAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageObservation {
    pub account_id: String,
    pub source: String,
    pub scope: String,
    pub metric: String,
    pub unit: String,
    pub provenance: String,
    pub period_start: String,
    pub period_end: String,
    pub granularity: String,
    pub value: f64,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub feature: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
    pub observed_at: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalyticsFilter {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub account_ids: Option<Vec<String>>,
    pub model: Option<String>,
    pub platform: Option<String>,
    pub feature: Option<String>,
    pub provenance: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricAggregate {
    pub account_id: String,
    pub source: String,
    pub scope: String,
    pub metric: String,
    pub unit: String,
    pub provenance: String,
    pub value: f64,
}

#[derive(Debug, Serialize)]
pub struct DailyAggregate {
    #[serde(flatten)]
    pub metric: MetricAggregate,
    pub date: String,
}

#[derive(Debug, Serialize)]
pub struct UsageBreakdown {
    #[serde(flatten)]
    pub metric: MetricAggregate,
    pub dimension: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncRun {
    pub id: String,
    pub account_id: String,
    pub source: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub imported: u64,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsDashboard {
    pub accounts: Vec<AnalyticsAccount>,
    pub totals: Vec<MetricAggregate>,
    pub daily: Vec<DailyAggregate>,
    pub breakdowns: Vec<UsageBreakdown>,
    pub record_count: u64,
    pub sync_history: Vec<SyncRun>,
}

#[derive(Debug, Default, Serialize)]
pub struct ImportResult {
    pub imported: u64,
    pub skipped: u64,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalyticsBackup {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    pub accounts: Vec<AnalyticsAccount>,
    pub observations: Vec<UsageObservation>,
    pub sync_history: Vec<SyncRun>,
}

pub fn create_schema(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(include_str!("../database/unified_usage_v25.sql"))?;
    create_link_schema(conn)?;
    Ok(())
}

pub fn create_link_schema(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(include_str!("../database/unified_usage_v26.sql"))?;
    Ok(())
}

fn read_json(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = row.get(index)?;
    raw.map(|s| {
        serde_json::from_str(&s).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    })
    .transpose()
}

fn numeric_metadata(value: &Value, keys: &[&str]) -> Option<Value> {
    let mut clean = serde_json::Map::new();
    for key in keys {
        if let Some(number) = value.get(key) {
            if number.is_null()
                || number
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= MAX_SAFE_VALUE)
            {
                clean.insert((*key).to_owned(), number.clone());
            }
        }
    }
    (!clean.is_empty()).then_some(Value::Object(clean))
}

fn safe_summary(value: &Value) -> Option<Value> {
    numeric_metadata(
        value,
        &[
            "lifetimeTokens",
            "peakDailyTokens",
            "longestRunningTurnSec",
            "currentStreakDays",
            "longestStreakDays",
        ],
    )
}

fn safe_limit(value: &Value) -> Option<Value> {
    let mut clean = serde_json::Map::new();
    for key in ["limitId", "limitName", "planType"] {
        if let Some(text) = value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 256 && !s.contains(['\r', '\n']))
        {
            clean.insert(key.into(), Value::String(text.to_owned()));
        }
    }
    for key in ["primary", "secondary"] {
        if let Some(window) = value
            .get(key)
            .and_then(|v| numeric_metadata(v, &["usedPercent", "windowDurationMins", "resetsAt"]))
        {
            clean.insert(key.into(), window);
        }
    }
    if let Some(credits) = value.get("credits") {
        let mut allowed = serde_json::Map::new();
        for key in ["hasCredits", "unlimited"] {
            if let Some(boolean) = credits.get(key).and_then(Value::as_bool) {
                allowed.insert(key.into(), Value::Bool(boolean));
            }
        }
        if let Some(balance) = credits.get("balance").and_then(Value::as_str).filter(|s| {
            s.len() <= 64
                && s.parse::<f64>()
                    .is_ok_and(|n| n.is_finite() && n >= 0.0 && n <= MAX_SAFE_VALUE)
        }) {
            allowed.insert("balance".into(), Value::String(balance.into()));
        }
        if !allowed.is_empty() {
            clean.insert("credits".into(), Value::Object(allowed));
        }
    }
    (!clean.is_empty()).then_some(Value::Object(clean))
}

fn safe_quota(value: &Value) -> Option<Value> {
    let mut clean = serde_json::Map::new();
    if let Some(resets) = value
        .get("rateLimitResetCredits")
        .and_then(|v| numeric_metadata(v, &["availableCount"]))
    {
        clean.insert("rateLimitResetCredits".into(), resets);
    }
    if let Some(limit) = value.get("rateLimits").and_then(safe_limit) {
        clean.insert("rateLimits".into(), limit);
    }
    if let Some(limits) = value.get("rateLimitsByLimitId").and_then(Value::as_object) {
        let sanitized = limits
            .iter()
            .take(100)
            .filter(|(key, _)| key.len() <= 256)
            .filter_map(|(key, value)| safe_limit(value).map(|limit| (key.clone(), limit)))
            .collect();
        clean.insert("rateLimitsByLimitId".into(), Value::Object(sanitized));
    }
    (!clean.is_empty()).then_some(Value::Object(clean))
}

fn account_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnalyticsAccount> {
    Ok(AnalyticsAccount {
        id: row.get(0)?,
        name: row.get(1)?,
        identity: row.get(2)?,
        subscription: row.get(3)?,
        connection_status: row.get(4)?,
        last_sync_at: row.get(5)?,
        last_error: row.get(6)?,
        sync_interval_minutes: row.get(7)?,
        summary: read_json(row, 8)?,
        quota: read_json(row, 9)?,
        quota_updated_at: row.get(10)?,
        created_at: row.get(11)?,
        linked_account_id: row.get(12)?,
    })
}

const ACCOUNT_COLUMNS: &str = "id,name,identity,subscription,connection_status,last_sync_at,last_error,sync_interval_minutes,summary_json,quota_json,quota_updated_at,created_at,(SELECT provider_account_id FROM unified_usage_account_links WHERE account_id=unified_usage_accounts.id)";

fn clean_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::InvalidInput(
            "Account name must contain 1–120 characters".into(),
        ));
    }
    Ok(name.to_owned())
}

pub fn validate_date(date: &str) -> Result<NaiveDate, AppError> {
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| AppError::InvalidInput("Dates must use YYYY-MM-DD".into()))?;
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err(AppError::InvalidInput("Dates must use YYYY-MM-DD".into()));
    }
    Ok(parsed)
}

fn validate_observation(row: &UsageObservation) -> Result<(), AppError> {
    if row.observed_at < 0
        || row.observed_at > Utc::now().timestamp_millis().saturating_add(300_000)
    {
        return Err(AppError::InvalidInput(
            "Observation capture time is invalid or more than five minutes in the future".into(),
        ));
    }
    for value in [
        &row.account_id,
        &row.source,
        &row.scope,
        &row.metric,
        &row.unit,
    ] {
        if value.trim().is_empty() || value.len() > 256 {
            return Err(AppError::InvalidInput(
                "Observation identifiers must contain 1–256 bytes".into(),
            ));
        }
    }
    if !row.value.is_finite() || row.value < 0.0 || row.value > MAX_SAFE_VALUE {
        return Err(AppError::InvalidInput(
            "Observation values must be finite, nonnegative, and within the exact JavaScript range"
                .into(),
        ));
    }
    if ["tokens", "messages", "requests", "images", "files"].contains(&row.unit.as_str())
        && row.value.fract() != 0.0
    {
        return Err(AppError::InvalidInput(
            "Count metrics require whole numbers".into(),
        ));
    }
    if !["official", "local", "estimated"].contains(&row.provenance.as_str()) {
        return Err(AppError::InvalidInput(
            "Invalid observation provenance".into(),
        ));
    }
    let start = validate_date(&row.period_start)?;
    let end = validate_date(&row.period_end)?;
    if end.signed_duration_since(start).num_days() != 1 {
        return Err(AppError::InvalidInput(
            "Observations must describe one UTC day (exclusive periodEnd)".into(),
        ));
    }
    if !["day", "event"].contains(&row.granularity.as_str())
        || (row.granularity == "event"
            && row
                .event_id
                .as_deref()
                .is_none_or(|id| id.trim().is_empty()))
        || (row.granularity == "day" && row.event_id.is_some())
    {
        return Err(AppError::InvalidInput(
            "Events require a stable eventId; daily snapshots must not have eventId".into(),
        ));
    }
    for dimension in [&row.model, &row.platform, &row.feature, &row.event_id] {
        if dimension.as_ref().is_some_and(|s| s.len() > 512) {
            return Err(AppError::InvalidInput(
                "Observation dimension exceeds 512 bytes".into(),
            ));
        }
    }
    Ok(())
}

fn observation_key(row: &UsageObservation) -> Result<String, AppError> {
    // A length-delimited JSON tuple avoids delimiter collisions. Values and
    // capture time are deliberately excluded so refreshed snapshots replace.
    let event = row.granularity == "event";
    let material = serde_json::to_vec(&(
        &row.account_id,
        &row.source,
        &row.scope,
        &row.metric,
        &row.unit,
        &row.provenance,
        if event { "" } else { &row.period_start },
        &row.granularity,
        if event {
            ""
        } else {
            row.model.as_deref().unwrap_or("")
        },
        if event {
            ""
        } else {
            row.platform.as_deref().unwrap_or("")
        },
        if event {
            ""
        } else {
            row.feature.as_deref().unwrap_or("")
        },
        &row.event_id,
    ))
    .map_err(|e| AppError::Config(e.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(material)))
}

fn write_observation(conn: &Connection, row: &UsageObservation) -> Result<usize, AppError> {
    validate_observation(row)?;
    let key = observation_key(row)?;
    let overlap:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM unified_usage_observations WHERE account_id=?1 AND source=?2 AND scope=?3 AND metric=?4 AND unit=?5 AND provenance=?6 AND period_start=?7 AND granularity<>?8 AND id<>?9)",params![row.account_id,row.source,row.scope,row.metric,row.unit,row.provenance,row.period_start,row.granularity,key],|r|r.get(0))?;
    if overlap {
        return Err(AppError::InvalidInput("Daily snapshots and individual events overlap within this metric coverage set; use a separate scope".into()));
    }
    let changed=conn.execute(
        "INSERT INTO unified_usage_observations(id,account_id,source,scope,metric,unit,provenance,period_start,period_end,granularity,value,model,platform,feature,event_id,observed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
         ON CONFLICT(id) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at,period_start=excluded.period_start,period_end=excluded.period_end,model=excluded.model,platform=excluded.platform,feature=excluded.feature
         WHERE excluded.observed_at >= unified_usage_observations.observed_at AND (excluded.value != unified_usage_observations.value OR excluded.period_start != unified_usage_observations.period_start OR excluded.model != unified_usage_observations.model OR excluded.platform != unified_usage_observations.platform OR excluded.feature != unified_usage_observations.feature)",
        params![key,row.account_id,row.source,row.scope,row.metric,row.unit,row.provenance,row.period_start,row.period_end,row.granularity,row.value,row.model.as_deref().unwrap_or(""),row.platform.as_deref().unwrap_or(""),row.feature.as_deref().unwrap_or(""),row.event_id,row.observed_at],
    )?;
    if changed == 0 {
        conn.execute(
            "UPDATE unified_usage_observations SET observed_at=MAX(observed_at,?2) WHERE id=?1",
            params![key, row.observed_at],
        )?;
    }
    Ok(changed)
}

fn observation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageObservation> {
    let dimension = |i| {
        row.get::<_, String>(i)
            .map(|s| (!s.is_empty()).then_some(s))
    };
    Ok(UsageObservation {
        account_id: row.get(0)?,
        source: row.get(1)?,
        scope: row.get(2)?,
        metric: row.get(3)?,
        unit: row.get(4)?,
        provenance: row.get(5)?,
        period_start: row.get(6)?,
        period_end: row.get(7)?,
        granularity: row.get(8)?,
        value: row.get(9)?,
        model: dimension(10)?,
        platform: dimension(11)?,
        feature: dimension(12)?,
        event_id: row.get(13)?,
        observed_at: row.get(14)?,
    })
}

fn metric_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MetricAggregate> {
    let value: f64 = row.get(6)?;
    if !value.is_finite() || value > MAX_SAFE_VALUE {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Real,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Selected aggregate exceeds the safe numeric range; narrow the date range",
            )),
        ));
    }
    Ok(MetricAggregate {
        account_id: row.get(0)?,
        source: row.get(1)?,
        scope: row.get(2)?,
        metric: row.get(3)?,
        unit: row.get(4)?,
        provenance: row.get(5)?,
        value,
    })
}

fn sync_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncRun> {
    Ok(SyncRun {
        id: row.get(0)?,
        account_id: row.get(1)?,
        source: row.get(2)?,
        started_at: row.get(3)?,
        finished_at: row.get(4)?,
        status: row.get(5)?,
        imported: row.get(6)?,
        error: row.get(7)?,
    })
}

impl Database {
    /// Subscribe analytics to metadata already managed by CC Switch. This method
    /// has no authentication manager, token, network, or logout capability.
    pub fn unified_usage_import_existing_accounts(
        &self,
        sources: &[ExistingAccountMetadata],
    ) -> Result<ExistingAccountsImportResult, AppError> {
        self.unified_usage_reconcile_metadata(sources, true)
    }

    /// Automatic discovery adds new accounts only. Existing subscriptions,
    /// errors, names, authorization states and deliberate disconnects stay intact.
    pub fn unified_usage_reconcile_existing_accounts(
        &self,
        sources: &[ExistingAccountMetadata],
    ) -> Result<ExistingAccountsImportResult, AppError> {
        self.unified_usage_reconcile_metadata(sources, false)
    }

    fn unified_usage_reconcile_metadata(
        &self,
        sources: &[ExistingAccountMetadata],
        reactivate: bool,
    ) -> Result<ExistingAccountsImportResult, AppError> {
        let mut seen = HashSet::new();
        for source in sources {
            if source.provider_account_id.trim().is_empty()
                || source.provider_account_id.len() > 512
                || !seen.insert(source.provider_account_id.clone())
            {
                return Err(AppError::InvalidInput(
                    "Original account metadata has an invalid or duplicate stable ID".into(),
                ));
            }
        }
        let mut imported = 0;
        let mut skipped = 0;
        {
            let mut conn = lock_conn!(self.conn);
            let tx = conn.transaction()?;
            let mut excluded = excluded_source_ids(&tx)?;
            if reactivate {
                let before = excluded.len();
                for source in sources {
                    excluded.remove(&source.provider_account_id);
                }
                if excluded.len() != before {
                    save_excluded_source_ids(&tx, &excluded)?;
                }
            }
            for source in sources {
                if excluded.contains(&source.provider_account_id) {
                    skipped += 1;
                    continue;
                }
                let login = source.login.trim();
                // CodexOAuthManager publishes its email as login; legacy accounts
                // may instead contain a ChatGPT(workspace) label. Never merge that
                // unverifiable fallback as an authenticated person.
                let identity = (login.len() <= 320
                    && login.split('@').count() == 2
                    && !login.starts_with('@')
                    && !login.ends_with('@')
                    && !login.chars().any(char::is_whitespace))
                .then(|| login.to_lowercase());
                let requires_reauth = source.reauth_required || identity.is_none();
                let status = if requires_reauth {
                    "reauth_required"
                } else {
                    "connected"
                };
                let note=requires_reauth.then_some("Reconnect this account in the original CC Switch Accounts panel, then import existing accounts again. No original account was changed.");
                let existing:Option<String>=tx.query_row("SELECT account_id FROM unified_usage_account_links WHERE provider_account_id=?1",[&source.provider_account_id],|row|row.get(0)).optional()?;
                if let Some(id) = existing {
                    if !reactivate {
                        skipped += 1;
                        continue;
                    }
                    let previous:(Option<String>,String,Option<String>)=tx.query_row("SELECT identity,connection_status,last_error FROM unified_usage_accounts WHERE id=?1",[&id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
                    // A stable source ID must not silently retarget historical
                    // usage if its exposed identity changes.
                    if previous
                        .0
                        .as_ref()
                        .zip(identity.as_ref())
                        .is_some_and(|(prior, next)| prior != next)
                    {
                        skipped += 1;
                        continue;
                    }
                    if let Some(email) = &identity {
                        let occupied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM unified_usage_accounts WHERE identity=?1 AND id<>?2)",params![email,id],|row|row.get(0))?;
                        if occupied {
                            skipped += 1;
                            continue;
                        }
                    }
                    let effective_identity = previous.0.clone().or_else(|| identity.clone());
                    if previous.0 == effective_identity
                        && previous.1 == status
                        && previous.2.as_deref() == note
                    {
                        skipped += 1;
                        continue;
                    }
                    tx.execute("UPDATE unified_usage_accounts SET identity=COALESCE(identity,?2),connection_status=?3,last_error=?4 WHERE id=?1",params![id,identity,status,note])?;
                    imported += 1;
                    continue;
                }
                // An independently authorized profile already covering this
                // email remains untouched. Do not relink or duplicate its data.
                if let Some(email) = &identity {
                    let occupied: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM unified_usage_accounts WHERE identity=?1)",
                        [email],
                        |row| row.get(0),
                    )?;
                    if occupied {
                        skipped += 1;
                        continue;
                    }
                }
                let id = uuid::Uuid::new_v4().to_string();
                let name = if login.is_empty() {
                    "Existing ChatGPT account".to_owned()
                } else {
                    login.chars().take(120).collect()
                };
                tx.execute("INSERT INTO unified_usage_accounts(id,name,identity,connection_status,last_error,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![id,name,identity,status,note,Utc::now().timestamp_millis()])?;
                tx.execute("INSERT INTO unified_usage_account_links(account_id,provider_account_id) VALUES(?1,?2)",params![id,source.provider_account_id])?;
                imported += 1;
            }
            tx.commit()?;
        }
        Ok(ExistingAccountsImportResult {
            imported,
            skipped,
            accounts: self.unified_usage_accounts()?,
        })
    }

    /// Operational unsubscribe only. Retain nonsecret provenance for explicit
    /// idempotent re-import; no source account or credential is altered.
    pub fn unified_usage_disconnect_linked(&self, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("UPDATE unified_usage_accounts SET connection_status='disconnected',last_error=NULL WHERE id=?1 AND EXISTS(SELECT 1 FROM unified_usage_account_links WHERE account_id=?1)",[id])?;
        Ok(())
    }

    pub fn unified_usage_accounts(&self) -> Result<Vec<AnalyticsAccount>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS} FROM unified_usage_accounts ORDER BY created_at,id"
        ))?;
        let accounts = stmt
            .query_map([], account_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(accounts)
    }

    pub fn unified_usage_account(&self, id: &str) -> Result<AnalyticsAccount, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            &format!("SELECT {ACCOUNT_COLUMNS} FROM unified_usage_accounts WHERE id=?1"),
            [id],
            account_row,
        )
        .optional()?
        .ok_or_else(|| AppError::InvalidInput("Analytics account not found".into()))
    }

    pub fn unified_usage_add_account(&self, name: &str) -> Result<AnalyticsAccount, AppError> {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = lock_conn!(self.conn);
            conn.execute(
                "INSERT INTO unified_usage_accounts(id,name,created_at) VALUES(?1,?2,?3)",
                params![id, clean_name(name)?, Utc::now().timestamp_millis()],
            )?;
        }
        self.unified_usage_account(&id)
    }

    pub fn unified_usage_update_account(
        &self,
        id: &str,
        name: &str,
        minutes: u32,
    ) -> Result<AnalyticsAccount, AppError> {
        if minutes != 0 && !(5..=1440).contains(&minutes) {
            return Err(AppError::InvalidInput(
                "Sync interval must be 0 (manual) or 5–1440 minutes".into(),
            ));
        }
        {
            let conn = lock_conn!(self.conn);
            conn.execute(
                "UPDATE unified_usage_accounts SET name=?2,sync_interval_minutes=?3 WHERE id=?1",
                params![id, clean_name(name)?, minutes],
            )?;
        }
        self.unified_usage_account(id)
    }

    pub fn unified_usage_remove_account(&self, id: &str) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let linked: Option<String> = tx
            .query_row(
                "SELECT provider_account_id FROM unified_usage_account_links WHERE account_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(source_id) = linked {
            let mut excluded = excluded_source_ids(&tx)?;
            excluded.insert(source_id);
            save_excluded_source_ids(&tx, &excluded)?;
        }
        tx.execute("DELETE FROM unified_usage_accounts WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn unified_usage_set_status(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), AppError> {
        if ![
            "pending",
            "connected",
            "disconnected",
            "error",
            "reauth_required",
            "unsupported",
        ]
        .contains(&status)
        {
            return Err(AppError::InvalidInput(
                "Invalid account connection status".into(),
            ));
        }
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE unified_usage_accounts SET connection_status=?2,last_error=?3 WHERE id=?1",
            params![id, status, error],
        )?;
        Ok(())
    }

    pub fn unified_usage_bind_identity(&self, id: &str, account: &Value) -> Result<(), AppError> {
        let account = account.get("account").unwrap_or(account);
        if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(AppError::InvalidInput(
                "Analytics requires supported ChatGPT account authorization".into(),
            ));
        }
        let email = account
            .get("email")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AppError::InvalidInput(
                    "Codex did not return an account email; account identity cannot be verified"
                        .into(),
                )
            })?;
        // Current documented account/read exposes email, but no stable user or
        // workspace ID. Reject a duplicate email rather than count one person
        // twice using mutable workspace display names.
        let identity = email.trim().to_lowercase();
        let subscription = account.get("planType").and_then(Value::as_str);
        let conn = lock_conn!(self.conn);
        let previous: Option<String> = conn.query_row(
            "SELECT identity FROM unified_usage_accounts WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        if previous.as_ref().is_some_and(|prior| prior != &identity) {
            return Err(AppError::InvalidInput(
                "Reconnect must use the original ChatGPT account".into(),
            ));
        }
        let duplicate: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM unified_usage_accounts WHERE identity=?1 AND id<>?2)",
            params![identity, id],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(AppError::InvalidInput(
                "This ChatGPT account is already connected".into(),
            ));
        }
        conn.execute("UPDATE unified_usage_accounts SET identity=?2,subscription=?3,connection_status='connected',last_error=NULL WHERE id=?1", params![id,identity,subscription])?;
        Ok(())
    }

    pub fn unified_usage_begin_sync(&self, id: &str, source: &str) -> Result<String, AppError> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let conn = lock_conn!(self.conn);
        conn.execute("INSERT INTO unified_usage_sync_runs(id,account_id,source,started_at,status) VALUES(?1,?2,?3,?4,'running')", params![run_id,id,source,Utc::now().timestamp_millis()])?;
        Ok(run_id)
    }

    pub fn unified_usage_finish_sync(
        &self,
        run_id: &str,
        status: &str,
        imported: u64,
        error: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("UPDATE unified_usage_sync_runs SET finished_at=?2,status=?3,imported=?4,error=?5 WHERE id=?1", params![run_id,Utc::now().timestamp_millis(),status,imported,error])?;
        Ok(())
    }

    pub fn unified_usage_recover_interrupted(&self) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("UPDATE unified_usage_sync_runs SET finished_at=?1,status='interrupted',error='Application stopped before synchronization completed; retry is safe' WHERE status='running'", [Utc::now().timestamp_millis()])?;
        Ok(())
    }

    pub fn unified_usage_apply_official(
        &self,
        id: &str,
        usage: Option<&Value>,
        quota: Option<&Value>,
    ) -> Result<u64, AppError> {
        let now = Utc::now().timestamp_millis();
        let observations = official_observations(id, usage, now)?;
        let summary = usage
            .and_then(|u| u.get("summary"))
            .and_then(safe_summary)
            .map(|v| serde_json::to_string(&v))
            .transpose()
            .map_err(|e| AppError::Config(e.to_string()))?;
        let quota = quota
            .and_then(safe_quota)
            .map(|v| serde_json::to_string(&v))
            .transpose()
            .map_err(|e| AppError::Config(e.to_string()))?;
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let mut imported = 0;
        for observation in &observations {
            imported += write_observation(&tx, observation)? as u64;
        }
        tx.execute("UPDATE unified_usage_accounts SET last_sync_at=?2,summary_json=COALESCE(?3,summary_json),quota_json=COALESCE(?4,quota_json),quota_updated_at=CASE WHEN ?4 IS NOT NULL THEN ?2 ELSE quota_updated_at END WHERE id=?1", params![id,now,summary,quota])?;
        tx.commit()?;
        Ok(imported)
    }

    pub fn unified_usage_import_observations(
        &self,
        id: &str,
        observations: &[UsageObservation],
    ) -> Result<ImportResult, AppError> {
        self.unified_usage_account(id)?;
        for row in observations {
            validate_observation(row)?;
            if row.account_id != id {
                return Err(AppError::InvalidInput(
                    "Imported observations belong to another account".into(),
                ));
            }
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let mut result = ImportResult::default();
        for row in observations {
            if write_observation(&tx, row)? == 0 {
                result.skipped += 1;
            } else {
                result.imported += 1;
            }
        }
        tx.commit()?;
        Ok(result)
    }

    pub fn unified_usage_dashboard(
        &self,
        filter: &AnalyticsFilter,
    ) -> Result<AnalyticsDashboard, AppError> {
        let accounts = self.unified_usage_accounts()?;
        let (where_sql, values) = filter_sql(filter)?;
        let conn = lock_conn!(self.conn);
        let columns = "account_id,source,scope,metric,unit,provenance,SUM(value)";
        let keys = "account_id,source,scope,metric,unit,provenance";
        let mut stmt = conn.prepare(&format!("SELECT {columns} FROM unified_usage_observations {where_sql} GROUP BY {keys} ORDER BY scope,metric,account_id"))?;
        let totals = stmt
            .query_map(rusqlite::params_from_iter(&values), metric_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = conn.prepare(&format!("SELECT {columns},period_start FROM unified_usage_observations {where_sql} GROUP BY {keys},period_start ORDER BY period_start"))?;
        let daily = stmt
            .query_map(rusqlite::params_from_iter(&values), |row| {
                Ok(DailyAggregate {
                    metric: metric_row(row)?,
                    date: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut breakdowns = Vec::new();
        for dimension in ["model", "platform", "feature"] {
            let mut stmt = conn.prepare(&format!("SELECT {columns},CASE WHEN {dimension}='' THEN 'Unavailable' ELSE {dimension} END FROM unified_usage_observations {where_sql} GROUP BY {keys},{dimension} ORDER BY SUM(value) DESC"))?;
            breakdowns.extend(
                stmt.query_map(rusqlite::params_from_iter(&values), |row| {
                    Ok(UsageBreakdown {
                        metric: metric_row(row)?,
                        dimension: dimension.to_owned(),
                        label: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?,
            );
        }
        let record_count = conn.query_row(
            &format!("SELECT COUNT(*) FROM unified_usage_observations {where_sql}"),
            rusqlite::params_from_iter(&values),
            |row| row.get(0),
        )?;
        let mut stmt = conn.prepare("SELECT id,account_id,source,started_at,finished_at,status,imported,error FROM unified_usage_sync_runs ORDER BY started_at DESC LIMIT 100")?;
        let sync_history = stmt
            .query_map([], sync_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(AnalyticsDashboard {
            accounts,
            totals,
            daily,
            breakdowns,
            record_count,
            sync_history,
        })
    }

    pub fn unified_usage_export(&self) -> Result<AnalyticsBackup, AppError> {
        // All tables are read under a single connection lock, so account deletion
        // cannot race the observation snapshot.
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS} FROM unified_usage_accounts ORDER BY created_at,id"
        ))?;
        let mut accounts = stmt
            .query_map([], account_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for account in &mut accounts {
            account.linked_account_id = None;
        }
        let mut stmt = conn.prepare("SELECT account_id,source,scope,metric,unit,provenance,period_start,period_end,granularity,value,model,platform,feature,event_id,observed_at FROM unified_usage_observations ORDER BY period_start,id")?;
        let observations = stmt
            .query_map([], observation_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = conn.prepare("SELECT id,account_id,source,started_at,finished_at,status,imported,error FROM unified_usage_sync_runs ORDER BY started_at")?;
        let sync_history = stmt
            .query_map([], sync_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(AnalyticsBackup {
            format: "cc-switch-unified-usage".into(),
            version: 1,
            exported_at: Utc::now().timestamp_millis(),
            accounts,
            observations,
            sync_history,
        })
    }

    pub fn unified_usage_restore(
        &self,
        backup: &AnalyticsBackup,
    ) -> Result<ImportResult, AppError> {
        if backup.format != "cc-switch-unified-usage" || backup.version != 1 {
            return Err(AppError::InvalidInput(
                "Unsupported analytics backup format/version".into(),
            ));
        }
        let mut account_ids = HashSet::new();
        let mut identities = HashSet::new();
        for account in &backup.accounts {
            uuid::Uuid::parse_str(&account.id)
                .map_err(|_| AppError::InvalidInput("Backup has invalid account ID".into()))?;
            clean_name(&account.name)?;
            if !account_ids.insert(account.id.clone())
                || account
                    .identity
                    .as_ref()
                    .is_some_and(|i| !identities.insert(i.clone()))
            {
                return Err(AppError::InvalidInput(
                    "Backup contains duplicate account identities".into(),
                ));
            }
        }
        for row in &backup.observations {
            validate_observation(row)?;
            if !account_ids.contains(&row.account_id) {
                return Err(AppError::InvalidInput(
                    "Backup observation refers to missing account".into(),
                ));
            }
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let mut result = ImportResult::default();
        for account in &backup.accounts {
            let existing: Option<Option<String>> = tx
                .query_row(
                    "SELECT identity FROM unified_usage_accounts WHERE id=?1",
                    [&account.id],
                    |row| row.get(0),
                )
                .optional()?;
            if existing
                .as_ref()
                .is_some_and(|identity| identity != &account.identity)
            {
                return Err(AppError::InvalidInput(
                    "Backup account identity conflicts with local account".into(),
                ));
            }
            let interval = if account.sync_interval_minutes == 0
                || (5..=1440).contains(&account.sync_interval_minutes)
            {
                account.sync_interval_minutes
            } else {
                0
            };
            let summary = account
                .summary
                .as_ref()
                .and_then(safe_summary)
                .map(|v| serde_json::to_string(&v))
                .transpose()
                .map_err(|e| AppError::Config(e.to_string()))?;
            let quota = account
                .quota
                .as_ref()
                .and_then(safe_quota)
                .map(|v| serde_json::to_string(&v))
                .transpose()
                .map_err(|e| AppError::Config(e.to_string()))?;
            tx.execute("INSERT INTO unified_usage_accounts(id,name,identity,subscription,connection_status,last_sync_at,created_at,sync_interval_minutes,summary_json,quota_json,quota_updated_at) VALUES(?1,?2,?3,?4,'disconnected',?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO NOTHING",params![account.id,account.name,account.identity,account.subscription,account.last_sync_at,account.created_at,interval,summary,quota,account.quota_updated_at])?;
        }
        for row in &backup.observations {
            if write_observation(&tx, row)? == 0 {
                result.skipped += 1;
            } else {
                result.imported += 1;
            }
        }
        for run in &backup.sync_history {
            if !account_ids.contains(&run.account_id) {
                return Err(AppError::InvalidInput(
                    "Backup sync history refers to missing account".into(),
                ));
            }
            tx.execute("INSERT OR IGNORE INTO unified_usage_sync_runs(id,account_id,source,started_at,finished_at,status,imported,error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![run.id,run.account_id,run.source,run.started_at,run.finished_at,if run.status=="running" {"interrupted"} else {&run.status},run.imported,run.error])?;
        }
        tx.commit()?;
        result.warnings.push("Backup records preserve their declared provenance and are not independently reverified. Restored accounts require sign-in; credentials are never exported.".into());
        Ok(result)
    }
}

fn filter_sql(filter: &AnalyticsFilter) -> Result<(String, Vec<String>), AppError> {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    if let Some(date) = &filter.start_date {
        validate_date(date)?;
        clauses.push("period_start>=?".to_owned());
        values.push(date.clone());
    }
    if let Some(date) = &filter.end_date {
        validate_date(date)?;
        clauses.push("period_start<=?".to_owned());
        values.push(date.clone());
    }
    if filter
        .start_date
        .as_ref()
        .zip(filter.end_date.as_ref())
        .is_some_and(|(s, e)| s > e)
    {
        return Err(AppError::InvalidInput(
            "Start date must not be later than end date".into(),
        ));
    }
    if let Some(ids) = &filter.account_ids {
        if ids.len() > 1000 {
            return Err(AppError::InvalidInput("Too many account filters".into()));
        }
        if ids.is_empty() {
            clauses.push("0".into());
        } else {
            clauses.push(format!(
                "account_id IN ({})",
                vec!["?"; ids.len()].join(",")
            ));
            values.extend(ids.iter().cloned());
        }
    }
    for (column, value) in [
        ("model", &filter.model),
        ("platform", &filter.platform),
        ("feature", &filter.feature),
        ("provenance", &filter.provenance),
    ] {
        if let Some(value) = value {
            clauses.push(format!("{column}=?"));
            values.push(value.clone());
        }
    }
    Ok((
        if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        },
        values,
    ))
}

pub fn official_observations(
    id: &str,
    usage: Option<&Value>,
    now: i64,
) -> Result<Vec<UsageObservation>, AppError> {
    let Some(buckets) = usage
        .and_then(|u| u.get("dailyUsageBuckets"))
        .filter(|v| !v.is_null())
    else {
        return Ok(Vec::new());
    };
    let buckets = buckets.as_array().ok_or_else(|| {
        AppError::InvalidInput("Codex returned malformed daily usage buckets".into())
    })?;
    let mut output = Vec::new();
    let mut dates = HashSet::new();
    for bucket in buckets {
        let start = bucket
            .get("startDate")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::InvalidInput("Daily bucket has no date".into()))?;
        let date = validate_date(start)?;
        if !dates.insert(start.to_owned()) {
            return Err(AppError::InvalidInput(
                "Codex returned duplicate daily buckets".into(),
            ));
        }
        let value = bucket
            .get("tokens")
            .and_then(Value::as_f64)
            .ok_or_else(|| {
                AppError::InvalidInput("Daily bucket has no measured token count".into())
            })?;
        let row = UsageObservation {
            account_id: id.to_owned(),
            source: "codex_app_server".into(),
            scope: "codex_account_activity".into(),
            metric: "tokens".into(),
            unit: "tokens".into(),
            provenance: "official".into(),
            period_start: start.to_owned(),
            period_end: date
                .succ_opt()
                .ok_or_else(|| AppError::InvalidInput("Date overflow".into()))?
                .format("%Y-%m-%d")
                .to_string(),
            granularity: "day".into(),
            value,
            model: None,
            platform: None,
            feature: None,
            event_id: None,
            observed_at: now,
        };
        validate_observation(&row)?;
        output.push(row);
    }
    Ok(output)
}

/// ChatGPT exports carry conversations and message metadata, not a documented
/// token ledger. Count user-authored message IDs only; never store their text.
pub fn chatgpt_export_observations(
    id: &str,
    document: &Value,
) -> Result<(Vec<UsageObservation>, Vec<String>), AppError> {
    let conversations = document
        .as_array()
        .or_else(|| document.get("conversations").and_then(Value::as_array))
        .ok_or_else(|| {
            AppError::InvalidInput(
                "Select extracted conversations.json, not a ZIP or chat.html".into(),
            )
        })?;
    let now = Utc::now().timestamp_millis();
    let mut rows = Vec::new();
    let mut missing = 0;
    for conversation in conversations {
        let conversation_id = conversation
            .get("id")
            .or_else(|| conversation.get("conversation_id"))
            .and_then(Value::as_str);
        let Some(mapping) = conversation.get("mapping").and_then(Value::as_object) else {
            continue;
        };
        for (node_id, node) in mapping {
            let Some(message) = node.get("message").filter(|v| !v.is_null()) else {
                continue;
            };
            if message.pointer("/author/role").and_then(Value::as_str) != Some("user") {
                continue;
            }
            let timestamp = message.get("create_time").and_then(Value::as_f64);
            let message_id = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let Some((conversation_id, timestamp, message_id)) = conversation_id
                .zip(timestamp)
                .zip(message_id)
                .map(|((c, t), m)| (c, t, m))
            else {
                missing += 1;
                continue;
            };
            if !timestamp.is_finite() || timestamp < 0.0 || timestamp > 253_402_300_799.0 {
                missing += 1;
                continue;
            }
            let Some(date) =
                chrono::DateTime::from_timestamp(timestamp as i64, 0).map(|d| d.date_naive())
            else {
                missing += 1;
                continue;
            };
            let Some(end) = date.succ_opt() else {
                missing += 1;
                continue;
            };
            let _ = node_id;
            rows.push(UsageObservation {
                account_id: id.to_owned(),
                source: "chatgpt_data_export".into(),
                scope: "chatgpt_export_activity".into(),
                metric: "user_messages".into(),
                unit: "messages".into(),
                provenance: "local".into(),
                period_start: date.format("%Y-%m-%d").to_string(),
                period_end: end.format("%Y-%m-%d").to_string(),
                granularity: "event".into(),
                value: 1.0,
                model: None,
                platform: None,
                feature: Some("conversation".into()),
                event_id: Some(format!("{conversation_id}:{message_id}")),
                observed_at: now,
            });
        }
    }
    let mut warnings=vec!["Export activity is counted locally from user-message metadata. It is not a token total or complete account ledger. Model, device, image, upload, voice, reasoning and quota data remain unavailable unless explicitly reported by a supported source. Assign this export to its original account.".into()];
    if missing > 0 {
        warnings.push(format!(
            "Skipped {missing} user messages without stable identity or valid timestamp."
        ));
    }
    Ok((rows, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn official(id: &str, date: &str, tokens: u64) -> Value {
        let _ = id;
        json!({"summary":{"lifetimeTokens":9999},"dailyUsageBuckets":[{"startDate":date,"tokens":tokens}]})
    }

    #[test]
    fn daily_snapshots_replace_and_accounts_remain_separate() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        let b = db.unified_usage_add_account("B")?;
        db.unified_usage_apply_official(&a.id, Some(&official(&a.id, "2026-11-01", 100)), None)?;
        db.unified_usage_apply_official(&b.id, Some(&official(&b.id, "2026-11-01", 200)), None)?;
        db.unified_usage_apply_official(&a.id, Some(&official(&a.id, "2026-11-01", 150)), None)?;
        let dashboard = db.unified_usage_dashboard(&AnalyticsFilter::default())?;
        assert_eq!(dashboard.record_count, 2);
        assert_eq!(dashboard.totals.iter().map(|m| m.value).sum::<f64>(), 350.0);
        assert_eq!(
            db.unified_usage_account(&a.id)?.summary.unwrap()["lifetimeTokens"],
            9999
        );
        db.unified_usage_set_status(&a.id, "disconnected", None)?;
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .record_count,
            2
        );
        Ok(())
    }

    #[test]
    fn importing_existing_accounts_is_metadata_only_and_idempotent() -> Result<(), AppError> {
        let db = Database::memory()?;
        let sources = vec![
            ExistingAccountMetadata {
                provider_account_id: "original-A".into(),
                login: "A@example.com".into(),
                reauth_required: false,
            },
            ExistingAccountMetadata {
                provider_account_id: "original-B".into(),
                login: "b@example.com".into(),
                reauth_required: false,
            },
        ];
        let original_snapshot = sources.clone();
        let first = db.unified_usage_import_existing_accounts(&sources)?;
        assert_eq!(first.imported, 2);
        assert_eq!(first.skipped, 0);
        assert_eq!(sources, original_snapshot);
        assert_eq!(
            first
                .accounts
                .iter()
                .filter(|a| a.linked_account_id.is_some())
                .count(),
            2
        );
        assert!(first
            .accounts
            .iter()
            .all(|a| a.last_sync_at.is_none() && a.summary.is_none() && a.quota.is_none()));
        let second = db.unified_usage_import_existing_accounts(&sources)?;
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, 2);
        assert_eq!(
            first.accounts.iter().map(|a| &a.id).collect::<Vec<_>>(),
            second.accounts.iter().map(|a| &a.id).collect::<Vec<_>>()
        );
        let backup = serde_json::to_string(&db.unified_usage_export()?).unwrap();
        assert!(!backup.contains("linkedAccountId"));
        assert!(!backup.contains("original-A"));
        assert!(!backup.contains("original-B"));
        assert!(!backup.contains("refresh_token"));
        assert!(!backup.contains("access_token"));
        Ok(())
    }

    #[test]
    fn automatic_account_discovery_only_adds_new_subscriptions() -> Result<(), AppError> {
        let db = Database::memory()?;
        let mut sources = vec![
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
        let original = db.unified_usage_import_existing_accounts(&sources)?;
        let a = original
            .accounts
            .iter()
            .find(|a| a.linked_account_id.as_deref() == Some("original-A"))
            .unwrap();
        let b = original
            .accounts
            .iter()
            .find(|a| a.linked_account_id.as_deref() == Some("original-B"))
            .unwrap();
        db.unified_usage_update_account(&a.id, "My custom account name", 15)?;
        db.unified_usage_apply_official(&a.id, Some(&official(&a.id, "2026-11-01", 42)), None)?;
        db.unified_usage_disconnect_linked(&a.id)?;
        db.unified_usage_set_status(
            &b.id,
            "reauth_required",
            Some("Keep this authorization error"),
        )?;
        sources.push(ExistingAccountMetadata {
            provider_account_id: "original-C".into(),
            login: "c@example.com".into(),
            reauth_required: false,
        });
        let result = db.unified_usage_reconcile_existing_accounts(&sources)?;
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 2);
        let preserved_a = db.unified_usage_account(&a.id)?;
        assert_eq!(preserved_a.name, "My custom account name");
        assert_eq!(preserved_a.sync_interval_minutes, 15);
        assert_eq!(preserved_a.connection_status, "disconnected");
        let preserved_b = db.unified_usage_account(&b.id)?;
        assert_eq!(preserved_b.connection_status, "reauth_required");
        assert_eq!(
            preserved_b.last_error.as_deref(),
            Some("Keep this authorization error")
        );
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .record_count,
            1
        );
        assert!(result
            .accounts
            .iter()
            .any(|account| account.linked_account_id.as_deref() == Some("original-C")));
        Ok(())
    }

    #[test]
    fn removing_linked_profile_excludes_rediscovery_until_explicit_import() -> Result<(), AppError>
    {
        let db = Database::memory()?;
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
        let original = db.unified_usage_reconcile_existing_accounts(&sources)?;
        let removed = original
            .accounts
            .iter()
            .find(|a| a.linked_account_id.as_deref() == Some("original-A"))
            .unwrap();
        db.unified_usage_apply_official(
            &removed.id,
            Some(&official(&removed.id, "2026-11-01", 10)),
            None,
        )?;
        db.unified_usage_remove_account(&removed.id)?;
        let auto = db.unified_usage_reconcile_existing_accounts(&sources)?;
        assert_eq!(auto.imported, 0);
        assert_eq!(auto.accounts.len(), 1);
        assert_eq!(
            auto.accounts[0].linked_account_id.as_deref(),
            Some("original-B")
        );
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .record_count,
            0
        );
        let mut all = sources.clone();
        all.push(ExistingAccountMetadata {
            provider_account_id: "original-C".into(),
            login: "c@example.com".into(),
            reauth_required: false,
        });
        assert_eq!(
            db.unified_usage_reconcile_existing_accounts(&all)?.imported,
            1
        );
        let manual = db.unified_usage_import_existing_accounts(&sources)?;
        assert_eq!(manual.imported, 1);
        assert_eq!(
            manual
                .accounts
                .iter()
                .filter(|a| a.linked_account_id.as_deref() == Some("original-A"))
                .count(),
            1
        );
        assert_eq!(
            db.unified_usage_reconcile_existing_accounts(&all)?.imported,
            0
        );
        Ok(())
    }

    #[test]
    fn linked_unsubscribe_reimport_and_remove_preserve_source_accounts_and_history(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let sources = vec![ExistingAccountMetadata {
            provider_account_id: "original-A".into(),
            login: "a@example.com".into(),
            reauth_required: false,
        }];
        let snapshot = sources.clone();
        let imported = db.unified_usage_import_existing_accounts(&sources)?;
        let id = imported.accounts[0].id.clone();
        db.unified_usage_apply_official(&id, Some(&official(&id, "2026-11-01", 100)), None)?;
        db.unified_usage_disconnect_linked(&id)?;
        let account = db.unified_usage_account(&id)?;
        assert_eq!(account.connection_status, "disconnected");
        assert_eq!(account.linked_account_id.as_deref(), Some("original-A"));
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .record_count,
            1
        );
        let reimported = db.unified_usage_import_existing_accounts(&sources)?;
        assert_eq!(reimported.imported, 1);
        assert_eq!(reimported.accounts[0].id, id);
        assert_eq!(reimported.accounts[0].connection_status, "connected");
        let backup = db.unified_usage_export()?;
        let restored = Database::memory()?;
        restored.unified_usage_restore(&backup)?;
        let restored_account = restored.unified_usage_account(&id)?;
        assert_eq!(restored_account.connection_status, "disconnected");
        assert!(restored_account.linked_account_id.is_none());
        db.unified_usage_remove_account(&id)?;
        assert!(db.unified_usage_accounts()?.is_empty());
        assert_eq!(sources, snapshot);
        let links: i64 = lock_conn!(db.conn).query_row(
            "SELECT COUNT(*) FROM unified_usage_account_links",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(links, 0);
        Ok(())
    }

    #[test]
    fn existing_isolated_profile_is_not_occupied_and_legacy_identity_requires_original_reauth(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let isolated = db.unified_usage_add_account("Independent")?;
        db.unified_usage_bind_identity(
            &isolated.id,
            &json!({"type":"chatgpt","email":"a@example.com"}),
        )?;
        let sources = vec![
            ExistingAccountMetadata {
                provider_account_id: "original-A".into(),
                login: "a@example.com".into(),
                reauth_required: false,
            },
            ExistingAccountMetadata {
                provider_account_id: "original-legacy".into(),
                login: "ChatGPT (workspace)".into(),
                reauth_required: true,
            },
        ];
        let result = db.unified_usage_import_existing_accounts(&sources)?;
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 1);
        assert!(db
            .unified_usage_account(&isolated.id)?
            .linked_account_id
            .is_none());
        let legacy = result
            .accounts
            .iter()
            .find(|a| a.linked_account_id.as_deref() == Some("original-legacy"))
            .unwrap();
        assert!(legacy.identity.is_none());
        assert_eq!(legacy.connection_status, "reauth_required");
        let upgraded = vec![ExistingAccountMetadata {
            provider_account_id: "original-legacy".into(),
            login: "b@example.com".into(),
            reauth_required: false,
        }];
        db.unified_usage_import_existing_accounts(&upgraded)?;
        let verified = db.unified_usage_account(&legacy.id)?;
        assert_eq!(verified.identity.as_deref(), Some("b@example.com"));
        assert_eq!(verified.connection_status, "connected");
        assert!(db
            .unified_usage_bind_identity(
                &legacy.id,
                &json!({"type":"chatgpt","email":"wrong@example.com"})
            )
            .is_err());
        Ok(())
    }

    #[test]
    fn null_is_unavailable_and_invalid_bucket_is_atomic() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        db.unified_usage_apply_official(
            &a.id,
            Some(&json!({"summary":null,"dailyUsageBuckets":null})),
            None,
        )?;
        assert!(db
            .unified_usage_dashboard(&AnalyticsFilter::default())?
            .totals
            .is_empty());
        assert!(db.unified_usage_apply_official(&a.id,Some(&json!({"dailyUsageBuckets":[{"startDate":"2026-11-01","tokens":10},{"startDate":"invalid","tokens":20}]})),None).is_err());
        assert_eq!(
            db.unified_usage_dashboard(&AnalyticsFilter::default())?
                .record_count,
            0
        );
        Ok(())
    }

    #[test]
    fn export_messages_are_deduplicated_and_not_tokens() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        let data = json!([{"id":"conversation","mapping":{"node":{"message":{"id":"message","author":{"role":"user"},"create_time":1793491200,"content":{"parts":["PRIVATE TEXT MUST NOT PERSIST"]}}}}}]);
        let (rows, _) = chatgpt_export_observations(&a.id, &data)?;
        assert_eq!(
            db.unified_usage_import_observations(&a.id, &rows)?.imported,
            1
        );
        assert_eq!(
            db.unified_usage_import_observations(&a.id, &rows)?.skipped,
            1
        );
        let backup = serde_json::to_string(&db.unified_usage_export()?).unwrap();
        assert!(!backup.contains("PRIVATE TEXT"));
        assert!(!backup.contains("content"));
        let dashboard = db.unified_usage_dashboard(&AnalyticsFilter::default())?;
        assert_eq!(dashboard.totals[0].metric, "user_messages");
        assert_eq!(dashboard.totals[0].unit, "messages");
        Ok(())
    }

    #[test]
    fn identity_binding_rejects_duplicate_and_wrong_reconnect() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        let b = db.unified_usage_add_account("B")?;
        db.unified_usage_bind_identity(
            &a.id,
            &json!({"type":"chatgpt","email":"a@example.com","planType":"pro"}),
        )?;
        assert!(db
            .unified_usage_bind_identity(&b.id, &json!({"type":"chatgpt","email":"A@example.com"}))
            .is_err());
        assert!(db
            .unified_usage_bind_identity(&a.id, &json!({"type":"chatgpt","email":"b@example.com"}))
            .is_err());
        Ok(())
    }

    #[test]
    fn backup_restores_history_but_never_connection_or_credentials() -> Result<(), AppError> {
        let db = Database::memory()?;
        let a = db.unified_usage_add_account("A")?;
        db.unified_usage_apply_official(&a.id, Some(&official(&a.id, "2026-11-01", 12)), None)?;
        let run = db.unified_usage_begin_sync(&a.id, "codex_app_server")?;
        let backup = db.unified_usage_export()?;
        let restored = Database::memory()?;
        restored.unified_usage_restore(&backup)?;
        assert_eq!(
            restored.unified_usage_account(&a.id)?.connection_status,
            "disconnected"
        );
        let dashboard = restored.unified_usage_dashboard(&AnalyticsFilter::default())?;
        assert_eq!(dashboard.record_count, 1);
        assert_eq!(dashboard.sync_history[0].id, run);
        assert_eq!(dashboard.sync_history[0].status, "interrupted");
        assert_eq!(restored.unified_usage_restore(&backup)?.skipped, 1);
        Ok(())
    }

    #[test]
    fn corrected_event_date_and_dimensions_replace_the_stable_event() -> Result<(), AppError> {
        let db = Database::memory()?;
        let account = db.unified_usage_add_account("A")?;
        let now = Utc::now().timestamp_millis();
        let mut row = official_observations(
            &account.id,
            Some(&official(&account.id, "2026-11-01", 10)),
            now - 10,
        )?
        .remove(0);
        row.source = "imported_usage".into();
        row.scope = "imported:events".into();
        row.granularity = "event".into();
        row.event_id = Some("event-1".into());
        db.unified_usage_import_observations(&account.id, &[row.clone()])?;
        row.period_start = "2026-11-02".into();
        row.period_end = "2026-11-03".into();
        row.model = Some("reported-model".into());
        row.observed_at = now;
        db.unified_usage_import_observations(&account.id, &[row])?;
        let dashboard = db.unified_usage_dashboard(&AnalyticsFilter::default())?;
        assert_eq!(dashboard.record_count, 1);
        assert_eq!(dashboard.daily[0].date, "2026-11-02");
        assert_eq!(dashboard.totals[0].value, 10.0);
        Ok(())
    }

    #[test]
    fn future_capture_times_and_unsafe_aggregates_are_rejected() -> Result<(), AppError> {
        let db = Database::memory()?;
        let account = db.unified_usage_add_account("A")?;
        let mut row = official_observations(
            &account.id,
            Some(&official(&account.id, "2026-11-01", 10)),
            Utc::now().timestamp_millis(),
        )?
        .remove(0);
        row.observed_at = Utc::now().timestamp_millis() + 600000;
        assert!(db
            .unified_usage_import_observations(&account.id, &[row])
            .is_err());
        db.unified_usage_apply_official(
            &account.id,
            Some(&official(&account.id, "2026-11-01", 9_007_199_254_740_991)),
            None,
        )?;
        db.unified_usage_apply_official(
            &account.id,
            Some(&official(&account.id, "2026-11-02", 1)),
            None,
        )?;
        assert!(db
            .unified_usage_dashboard(&AnalyticsFilter::default())
            .is_err());
        Ok(())
    }

    #[test]
    fn restored_snapshots_keep_only_recognized_numeric_usage_and_quota_fields(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let account = db.unified_usage_add_account("A")?;
        let mut backup = db.unified_usage_export()?;
        backup.accounts[0].summary = Some(
            json!({"lifetimeTokens":123,"password":"PRIVATE SECRET","messages":["PRIVATE CONVERSATION"]}),
        );
        backup.accounts[0].quota = Some(
            json!({"rateLimits":{"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1793491200,"accessToken":"PRIVATE SECRET"},"credits":{"hasCredits":true,"unlimited":false,"balance":"3.5"}},"rateLimitResetCredits":{"availableCount":2,"credits":[{"id":"PRIVATE RESET ID"}]},"refreshToken":"PRIVATE SECRET"}),
        );
        let restored = Database::memory()?;
        restored.unified_usage_restore(&backup)?;
        let account = restored.unified_usage_account(&account.id)?;
        assert_eq!(account.summary.unwrap()["lifetimeTokens"], 123);
        assert_eq!(
            account.quota.as_ref().unwrap()["rateLimits"]["primary"]["usedPercent"],
            25
        );
        assert_eq!(
            account.quota.as_ref().unwrap()["rateLimits"]["credits"]["balance"],
            "3.5"
        );
        assert_eq!(
            account.quota.as_ref().unwrap()["rateLimitResetCredits"]["availableCount"],
            2
        );
        let output = serde_json::to_string(&restored.unified_usage_export()?).unwrap();
        assert!(!output.contains("PRIVATE"));
        Ok(())
    }
}
