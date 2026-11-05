-- Analytics subscriptions to existing CC Switch accounts. No authentication data.
-- Removing an analytics profile cascades only its local link, never the source account.
CREATE TABLE IF NOT EXISTS unified_usage_account_links (
    account_id TEXT PRIMARY KEY REFERENCES unified_usage_accounts(id) ON DELETE CASCADE,
    provider_account_id TEXT UNIQUE NOT NULL
);
