//! Account-requested thread snapshots. Snapshot rows never enter daily sums.
use super::unified_usage_threads::{
    canonical_thread_id, parse_thread_usage, ThreadCandidate, ThreadUsageSnapshot, MAX_SAFE_INTEGER,
};
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashSet};

const MAX_CANDIDATES: usize = 4000;
const REFRESH_MS: i64 = 120_000;
const ERROR_RETRY_MS: i64 = 300_000;
const UNAVAILABLE_RETRY_MS: i64 = 15 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct ThreadCheckResult {
    pub thread_id: String,
    pub snapshot: Option<ThreadUsageSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsageRecord {
    pub account_id: String,
    pub thread_id: String,
    pub status: String,
    pub checked_at: i64,
    pub last_success_at: Option<i64>,
    pub snapshot: Option<ThreadUsageSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsageDashboard {
    pub records: Vec<ThreadUsageRecord>,
    pub candidate_count: usize,
}

pub fn create_thread_schema(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(include_str!("../database/unified_usage_v27.sql"))?;
    Ok(())
}

fn checked_time(now: i64) -> Result<(), AppError> {
    if now < 0 || now as u64 > MAX_SAFE_INTEGER {
        return Err(AppError::InvalidInput("Unsafe thread snapshot time".into()));
    }
    Ok(())
}

impl Database {
    /// Persists candidate metadata only. Returns at most three queries, reserving
    /// one slot for the oldest due snapshot while backfilling recent unseen IDs.
    pub fn unified_usage_thread_select_targets(
        &self,
        account_id: &str,
        candidates: &[ThreadCandidate],
        limit: usize,
        now: i64,
    ) -> Result<Vec<ThreadCandidate>, AppError> {
        checked_time(now)?;
        if candidates.len() > 40_000 {
            return Err(AppError::InvalidInput(
                "Too many local thread candidates".into(),
            ));
        }
        let mut unique = BTreeMap::<String, u64>::new();
        for candidate in candidates {
            let id = canonical_thread_id(&candidate.thread_id).map_err(AppError::InvalidInput)?;
            if candidate.modified_at_ms > MAX_SAFE_INTEGER {
                return Err(AppError::InvalidInput(
                    "Unsafe thread modification time".into(),
                ));
            }
            unique
                .entry(id)
                .and_modify(|old| *old = (*old).max(candidate.modified_at_ms))
                .or_insert(candidate.modified_at_ms);
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let account_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM unified_usage_accounts WHERE id=?1)",
            [account_id],
            |row| row.get(0),
        )?;
        if !account_exists {
            return Err(AppError::InvalidInput("Analytics account not found".into()));
        }
        for (id, modified) in unique {
            tx.execute("INSERT INTO unified_usage_thread_candidates(thread_id,modified_at_ms,discovered_at) VALUES(?1,?2,?3) ON CONFLICT(thread_id) DO UPDATE SET modified_at_ms=MAX(modified_at_ms,excluded.modified_at_ms),discovered_at=excluded.discovered_at",params![id,modified as i64,now])?;
        }
        tx.execute("DELETE FROM unified_usage_thread_candidates WHERE thread_id IN (SELECT thread_id FROM unified_usage_thread_candidates ORDER BY modified_at_ms DESC,thread_id LIMIT -1 OFFSET ?1)",[MAX_CANDIDATES as i64])?;
        let limit = limit.min(3);
        let mut unseen = Vec::new();
        let mut due = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT c.thread_id,c.modified_at_ms FROM unified_usage_thread_candidates c LEFT JOIN unified_usage_thread_records r ON r.thread_id=c.thread_id AND r.account_id=?1 WHERE r.thread_id IS NULL ORDER BY c.modified_at_ms DESC,c.thread_id LIMIT ?2")?;
            let rows = stmt.query_map(params![account_id, limit as i64], |row| {
                Ok(ThreadCandidate {
                    thread_id: row.get(0)?,
                    modified_at_ms: row.get(1)?,
                })
            })?;
            for row in rows {
                unseen.push(row?);
            }
            let mut stmt = tx.prepare("SELECT c.thread_id,c.modified_at_ms FROM unified_usage_thread_candidates c JOIN unified_usage_thread_records r ON r.thread_id=c.thread_id AND r.account_id=?1 WHERE c.modified_at_ms>r.checked_modified_at_ms OR r.checked_at<=?2-(CASE r.status WHEN 'unavailable' THEN ?3 WHEN 'error' THEN ?4 ELSE ?5 END) ORDER BY r.checked_at ASC,c.modified_at_ms DESC,c.thread_id LIMIT ?6")?;
            let rows = stmt.query_map(
                params![
                    account_id,
                    now,
                    UNAVAILABLE_RETRY_MS,
                    ERROR_RETRY_MS,
                    REFRESH_MS,
                    limit as i64
                ],
                |row| {
                    Ok(ThreadCandidate {
                        thread_id: row.get(0)?,
                        modified_at_ms: row.get(1)?,
                    })
                },
            )?;
            for row in rows {
                due.push(row?);
            }
        }
        let mut selected = Vec::new();
        if !unseen.is_empty() && !due.is_empty() && limit > 0 {
            let due_slots = if limit > 1 || (now / REFRESH_MS) % 2 == 1 {
                1
            } else {
                0
            };
            selected.extend(unseen.drain(..unseen.len().min(limit - due_slots)));
            selected.extend(due.drain(..due.len().min(due_slots)));
        }
        for candidate in unseen.into_iter().chain(due) {
            if selected.len() >= limit {
                break;
            }
            selected.push(candidate);
        }
        tx.commit()?;
        Ok(selected)
    }

    /// Atomic replacement snapshots. Failed/unavailable checks retain the last
    /// successful snapshot and capture time, while their status marks it stale.
    pub fn unified_usage_thread_apply_results(
        &self,
        account_id: &str,
        checks: &[ThreadCheckResult],
        now: i64,
    ) -> Result<(), AppError> {
        checked_time(now)?;
        if checks.len() > 3 {
            return Err(AppError::InvalidInput(
                "Too many thread checks in one sync".into(),
            ));
        }
        let mut normalized = Vec::new();
        let mut seen = HashSet::new();
        for check in checks {
            let id = canonical_thread_id(&check.thread_id).map_err(AppError::InvalidInput)?;
            if !seen.insert(id.clone()) || (check.snapshot.is_some() && check.error.is_some()) {
                return Err(AppError::InvalidInput(
                    "Duplicate or inconsistent thread check".into(),
                ));
            }
            let encoded = if let Some(snapshot) = &check.snapshot {
                if snapshot.day.is_some() {
                    return Err(AppError::InvalidInput(
                        "Thread snapshots cannot be assigned a usage day".into(),
                    ));
                }
                let value = serde_json::to_value(snapshot)
                    .map_err(|_| AppError::InvalidInput("Invalid thread snapshot".into()))?;
                let parsed = parse_thread_usage(&id, &json!({"threadUsage":value}))
                    .map_err(AppError::InvalidInput)?
                    .ok_or_else(|| AppError::InvalidInput("Missing thread snapshot".into()))?;
                Some(
                    serde_json::to_string(&parsed)
                        .map_err(|_| AppError::InvalidInput("Invalid thread snapshot".into()))?,
                )
            } else {
                None
            };
            let status = if encoded.is_some() {
                "available"
            } else if check.error.is_some() {
                "error"
            } else {
                "unavailable"
            };
            // Never retain arbitrary server/transport errors that could contain
            // bodies, credentials or local paths. Detailed diagnostics stay out.
            let error = check.error.as_ref().map(|_| "Thread usage refresh failed");
            normalized.push((id, status, encoded, error));
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let account_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM unified_usage_accounts WHERE id=?1)",
            [account_id],
            |row| row.get(0),
        )?;
        if !account_exists {
            return Err(AppError::InvalidInput("Analytics account not found".into()));
        }
        for (id, status, encoded, error) in normalized {
            tx.execute("INSERT INTO unified_usage_thread_records(account_id,thread_id,status,checked_at,checked_modified_at_ms,last_success_at,snapshot_json,error) VALUES(?1,?2,?3,?4,COALESCE((SELECT modified_at_ms FROM unified_usage_thread_candidates WHERE thread_id=?2),0),?5,?6,?7) ON CONFLICT(account_id,thread_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,checked_modified_at_ms=excluded.checked_modified_at_ms,last_success_at=CASE WHEN excluded.status='available' THEN excluded.last_success_at ELSE last_success_at END,snapshot_json=COALESCE(excluded.snapshot_json,snapshot_json),error=excluded.error",params![account_id,id,status,now,encoded.as_ref().map(|_|now),encoded,error])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// All accounts are returned so callers can detect shared-thread ambiguity
    /// before applying their display filter. This method reads no auth material.
    pub fn unified_usage_thread_dashboard(&self) -> Result<ThreadUsageDashboard, AppError> {
        let conn = lock_conn!(self.conn);
        let candidate_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM unified_usage_thread_candidates",
            [],
            |row| row.get(0),
        )?;
        let mut stmt=conn.prepare("SELECT account_id,thread_id,status,checked_at,last_success_at,snapshot_json,error FROM unified_usage_thread_records ORDER BY checked_at DESC,account_id,thread_id")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (account_id, thread_id, status, checked_at, last_success_at, raw, error) = row?;
            let snapshot = raw
                .map(|text| -> Result<_, AppError> {
                    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
                        AppError::Database("Stored thread snapshot is invalid".into())
                    })?;
                    parse_thread_usage(&thread_id, &json!({"threadUsage":value}))
                        .map_err(|_| AppError::Database("Stored thread snapshot is invalid".into()))
                })
                .transpose()?
                .flatten();
            records.push(ThreadUsageRecord {
                account_id,
                thread_id,
                status,
                checked_at,
                last_success_at,
                snapshot,
                error,
            });
        }
        Ok(ThreadUsageDashboard {
            records,
            candidate_count: candidate_count as usize,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const THREAD: &str = "019fc8ab-1fb2-7000-8000-000000000123";
    fn account(db: &Database) -> String {
        db.unified_usage_add_account("Test account").unwrap().id
    }
    fn candidate(id: &str, mtime: u64) -> ThreadCandidate {
        ThreadCandidate {
            thread_id: id.into(),
            modified_at_ms: mtime,
        }
    }
    fn snapshot() -> ThreadUsageSnapshot {
        parse_thread_usage(THREAD,&json!({"threadUsage":{"threadId":THREAD,"estimatedUsageCreditsMicros":0,"estimatedUsageUsdMicros":2_000_000,"nativeUsageUsdMicros":null,"groups":[]}})).unwrap().unwrap()
    }
    fn ready() -> Database {
        let db = Database::memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            create_thread_schema(&conn).unwrap();
        }
        db
    }

    #[test]
    fn snapshots_replace_preserve_history_on_failure_and_cascade_only_analytics() {
        let db = ready();
        let a = account(&db);
        let b = account(&db);
        let targets = db
            .unified_usage_thread_select_targets(&a, &[candidate(THREAD, 1)], 3, 1000)
            .unwrap();
        assert_eq!(targets.len(), 1);
        let available = ThreadCheckResult {
            thread_id: THREAD.into(),
            snapshot: Some(snapshot()),
            error: None,
        };
        db.unified_usage_thread_apply_results(&a, &[available.clone()], 1000)
            .unwrap();
        db.unified_usage_thread_apply_results(&b, &[available], 1001)
            .unwrap();
        db.unified_usage_thread_apply_results(
            &a,
            &[ThreadCheckResult {
                thread_id: THREAD.into(),
                snapshot: None,
                error: Some("secret fixture must not persist".into()),
            }],
            2000,
        )
        .unwrap();
        let view = db.unified_usage_thread_dashboard().unwrap();
        assert_eq!(view.candidate_count, 1);
        assert_eq!(view.records.len(), 2);
        let row = view.records.iter().find(|row| row.account_id == a).unwrap();
        assert_eq!(row.status, "error");
        assert_eq!(row.last_success_at, Some(1000));
        assert!(row.snapshot.is_some());
        assert!(!row.error.as_deref().unwrap().contains("secret"));
        db.unified_usage_thread_apply_results(
            &a,
            &[ThreadCheckResult {
                thread_id: THREAD.into(),
                snapshot: None,
                error: None,
            }],
            3000,
        )
        .unwrap();
        assert_eq!(
            db.unified_usage_thread_dashboard().unwrap().records.len(),
            2
        );
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM unified_usage_accounts WHERE id=?1", [&a])
                .unwrap();
        }
        let view = db.unified_usage_thread_dashboard().unwrap();
        assert_eq!(view.records.len(), 1);
        assert_eq!(view.records[0].account_id, b);
        assert_eq!(view.records[0].snapshot.as_ref().unwrap().day, None);
    }

    #[test]
    fn bounded_queue_backfills_and_reserves_a_due_refresh_slot() {
        let db = ready();
        let a = account(&db);
        let candidates = (0..6)
            .map(|n| candidate(&format!("019fc8ab-1fb2-7000-8000-{n:012}"), n + 1))
            .collect::<Vec<_>>();
        let first = db
            .unified_usage_thread_select_targets(&a, &candidates, 99, 1000)
            .unwrap();
        assert_eq!(first.len(), 3);
        for row in &first {
            db.unified_usage_thread_apply_results(
                &a,
                &[ThreadCheckResult {
                    thread_id: row.thread_id.clone(),
                    snapshot: None,
                    error: Some("offline".into()),
                }],
                1000,
            )
            .unwrap();
        }
        assert_eq!(
            db.unified_usage_thread_select_targets(&a, &candidates, 3, 2000)
                .unwrap()
                .len(),
            3
        );
        let later = db
            .unified_usage_thread_select_targets(&a, &candidates, 3, ERROR_RETRY_MS + 1001)
            .unwrap();
        assert_eq!(later.len(), 3);
        assert_eq!(
            later
                .iter()
                .filter(|row| first.iter().any(|old| old.thread_id == row.thread_id))
                .count(),
            1
        );
    }

    #[test]
    fn unavailable_thread_waits_fifteen_minutes_before_retry_without_local_changes() {
        let db = ready();
        let account = account(&db);
        let candidates = [candidate(THREAD, 1)];
        assert_eq!(
            db.unified_usage_thread_select_targets(&account, &candidates, 3, 1000)
                .unwrap()
                .len(),
            1
        );
        db.unified_usage_thread_apply_results(
            &account,
            &[ThreadCheckResult {
                thread_id: THREAD.into(),
                snapshot: None,
                error: None,
            }],
            1000,
        )
        .unwrap();
        assert!(db
            .unified_usage_thread_select_targets(&account, &candidates, 3, 1000 + REFRESH_MS)
            .unwrap()
            .is_empty());
        assert!(db
            .unified_usage_thread_select_targets(
                &account,
                &candidates,
                3,
                1000 + UNAVAILABLE_RETRY_MS - 1
            )
            .unwrap()
            .is_empty());
        assert_eq!(
            db.unified_usage_thread_select_targets(
                &account,
                &candidates,
                3,
                1000 + UNAVAILABLE_RETRY_MS
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn failed_atomic_batch_cannot_write_a_partial_snapshot_or_invent_a_day() {
        let db = ready();
        let a = account(&db);
        let good = ThreadCheckResult {
            thread_id: THREAD.into(),
            snapshot: Some(snapshot()),
            error: None,
        };
        let mut bad = good.clone();
        bad.thread_id = "019fc8ab-1fb2-7000-8000-000000000456".into();
        bad.snapshot.as_mut().unwrap().thread_id = bad.thread_id.clone();
        bad.snapshot.as_mut().unwrap().day = Some("2026-11-05".into());
        assert!(db
            .unified_usage_thread_apply_results(&a, &[good.clone(), bad], 1000)
            .is_err());
        assert!(db
            .unified_usage_thread_dashboard()
            .unwrap()
            .records
            .is_empty());
        db.unified_usage_thread_apply_results(&a, &[good.clone()], 1000)
            .unwrap();
        db.unified_usage_thread_apply_results(&a, &[good], 2000)
            .unwrap();
        let view = db.unified_usage_thread_dashboard().unwrap();
        assert_eq!(view.records.len(), 1);
        assert_eq!(view.records[0].last_success_at, Some(2000));
    }
}
