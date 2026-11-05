-- Official thread-lifetime snapshots, kept separate from account daily usage.
-- Candidate IDs identify local metadata only; they carry no account attribution.
CREATE TABLE IF NOT EXISTS unified_usage_thread_candidates (
    thread_id TEXT PRIMARY KEY,
    modified_at_ms INTEGER NOT NULL CHECK(modified_at_ms >= 0),
    discovered_at INTEGER NOT NULL CHECK(discovered_at >= 0)
);
CREATE TABLE IF NOT EXISTS unified_usage_thread_records (
    account_id TEXT NOT NULL REFERENCES unified_usage_accounts(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('available','unavailable','error')),
    checked_at INTEGER NOT NULL CHECK(checked_at >= 0),
    checked_modified_at_ms INTEGER NOT NULL DEFAULT 0,
    last_success_at INTEGER,
    snapshot_json TEXT,
    error TEXT,
    PRIMARY KEY(account_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_unified_usage_thread_queue
    ON unified_usage_thread_records(account_id, checked_at);
