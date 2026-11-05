-- Additive v24 -> v25 migration. No existing provider, auth, or usage table changes.
CREATE TABLE IF NOT EXISTS unified_usage_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    identity TEXT UNIQUE,
    subscription TEXT,
    connection_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_at INTEGER,
    last_error TEXT,
    sync_interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK(sync_interval_minutes = 0 OR sync_interval_minutes >= 5),
    summary_json TEXT,
    quota_json TEXT,
    quota_updated_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS unified_usage_observations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES unified_usage_accounts(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    scope TEXT NOT NULL,
    metric TEXT NOT NULL,
    unit TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK(provenance IN ('official','local','estimated')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    granularity TEXT NOT NULL CHECK(granularity IN ('day','event')),
    value REAL NOT NULL CHECK(value >= 0 AND value <= 9007199254740991),
    model TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    feature TEXT NOT NULL DEFAULT '',
    event_id TEXT,
    observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unified_usage_date ON unified_usage_observations(period_start,account_id);
CREATE INDEX IF NOT EXISTS idx_unified_usage_metric ON unified_usage_observations(account_id,scope,metric,provenance,period_start);
CREATE TABLE IF NOT EXISTS unified_usage_sync_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES unified_usage_accounts(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    imported INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_unified_usage_sync_account ON unified_usage_sync_runs(account_id,started_at DESC);
