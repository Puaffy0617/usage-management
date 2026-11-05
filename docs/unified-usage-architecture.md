# Unified Usage Analytics architecture

## Repository investigation

This feature extends upstream `farion1231/cc-switch`, commit
`ca58c0313360eae7c851fbd7553c1614c7af03e7` (4.0.25). Relevant code was inspected
before implementation. The desktop application uses React 18, TypeScript, Vite,
Tailwind, shadcn/Radix controls, TanStack Query, Recharts, and a Rust/Tauri 2 backend.

| Existing area | Relevant files | Existing behavior |
| --- | --- | --- |
| Local usage dashboard | `src/components/usage/UsagePage.tsx`, `UsageDashboard.tsx`, `src/lib/api/usage.ts` | Presents local proxy/session records and price calculations. |
| Usage query commands | `src-tauri/src/commands/usage.rs`, `src-tauri/src/services/usage_stats.rs` | Runs database work in a blocking pool; aggregates request records plus daily rollups. |
| Local measurement | `src-tauri/src/proxy/usage/logger.rs`, `src-tauri/src/services/session_usage*.rs` | Records proxy measurements and incrementally imports local client session metadata. |
| Local deduplication | `session_usage.rs`, `session_usage_codex.rs`, database schema | Uses persistent request/semantic identifiers and file cursors. Details older than 30 days may be rolled up and pruned. |
| Database | `src-tauri/src/database/mod.rs`, `schema.rs`, `backup.rs` | SQLite at the CC Switch configuration directory, schema v24 before this change, savepoint migrations and SQL backups. |
| Existing accounts | `src-tauri/src/commands/auth.rs`, `proxy/providers/codex_oauth_auth.rs` | Multiple provider-bound ChatGPT accounts and existing account-switching behavior. This manager stores its own token bundle in a JSON store. |
| Existing quota queries | `src-tauri/src/services/subscription.rs`, `commands/codex_oauth.rs` | Includes a private upstream quota endpoint. The new adapter does not call or reuse it. |
| Existing synchronization | `src-tauri/src/lib.rs`, `services/webdav_auto_sync.rs`, `s3_auto_sync.rs`, `sync_protocol.rs` | Local usage scans and optional configuration synchronization. Configuration sync excludes local usage data. |

Historical Codex session rows have the shared provider ID `_codex_session`, not
an authenticated account ID captured with each event. Current provider bindings
can change. Assigning those historical records to today's default account would
invent attribution, so the original local dashboard remains separate.

## Additive implementation

`services/unified_usage_codex.rs` is the official account adapter. It starts the
installed official Codex App Server on demand, uses its documented JSON-RPC
account methods, and shuts down the child when the operation finishes. Independent
browser-authorized analytics profiles use an isolated UUID-named `CODEX_HOME` and
the operating-system keyring. Imported existing CC Switch accounts use a separate
ephemeral App Server process and the documented external-account-token flow.
There is no password field, browser-cookie access, direct private HTTP endpoint,
or inference request.

`services/unified_usage.rs` contains normalized observations, the export metadata
adapter, validation, SQLite operations, aggregation, and backup restore.
`commands/unified_usage.rs` exposes the feature through native Tauri commands.
`src/components/usage/UnifiedUsageDashboard.tsx` and its typed API integrate the
account dashboard into the existing Usage page.

Existing CC Switch ChatGPT accounts are discovered using metadata only at startup,
when the analytics account list opens, and after successful original ChatGPT
authorization. Automatic discovery adds new source IDs only; it preserves existing
names, errors, reauthorization states, history and deliberately disconnected
subscriptions. An explicit Import action may reactivate an existing subscription.
Users can also add independent profiles through supported browser authorization.
None of these actions switches the current provider, changes the original
default account, overwrites the user's normal Codex login, or signs out any
existing account. Import reads `CodexOAuthManager::list_accounts` only: that method
clones public account metadata and computes display order under read locks. It
does not refresh credentials, save a store, or change the default account.

Each linked account is recorded by the original manager's stable local account ID,
independent of whichever account is currently active. On refresh, the original
manager alone obtains/refreshes its short-lived access token. Only that token and
the explicit workspace ID are passed in memory to documented
`account/login/start` with `type: chatgptAuthTokens`; the child uses ephemeral
credential storage. No refresh token or ID token is copied, and the external
adapter never calls logout. The official `account/read` response must match the
normalized email expected from the original account metadata before any usage is
stored. Legacy metadata without an email, or accounts marked for reauthorization,
remain unavailable until the original Accounts panel is reconnected and imported
again. An independent profile already covering the same email is skipped rather
than overwritten or linked twice.

Disconnecting a linked analytics profile unsubscribes analytics and retains its
history and nonsecret source mapping; it never logs out or removes the original
account. Explicitly importing existing accounts again reactivates the same
analytics ID. Removing the analytics profile cascades only its analytics rows and
mapping. That removal also records the nonsecret original source ID in the
existing SQLite settings key `unified_usage_excluded_source_ids_v1`, in the same
transaction. Later startup/list discovery continues adding genuinely new accounts
but does not recreate a profile the user removed. Explicit Import existing
accounts clears the supplied source IDs from that exclusion preference and can
create one new profile without restoring deleted history. No original account or
credential is removed, changed or copied. Portable analytics JSON backups do not
include this local discovery preference. Independent browser-authorized profiles retain their separate logout
behavior:
A nonsecret marker records that a profile has attempted authorization; it is
cleared only after successful official logout. An interrupted or rejected login
therefore cannot silently discard the obligation to clear its keyring entry.
Never-attempted/import-only profiles can be managed without an installed CLI.
The current documented account response provides an email but no suitable stable
user/workspace identifier. Email is normalized to reject duplicate profiles;
reconnecting a different email is refused. Multiple workspaces for the same email
are conservatively treated as the same identity until a documented stable ID and
coverage semantics can safely distinguish them. An account response without an
email is refused rather than silently assigned.

## Schema and migration

Schema v26 is additive. The initial analytics tables are defined in
`src-tauri/src/database/unified_usage_v25.sql`; the v25-to-v26 metadata-link table
is defined in `src-tauri/src/database/unified_usage_v26.sql`.

* `unified_usage_accounts`: names, verified identity label, subscription, connection
  state, last successful read, sync interval, allowlisted summary/quota snapshots,
  quota snapshot timestamp, and creation time. No credentials.
* `unified_usage_observations`: account, source, coverage scope, metric, unit,
  provenance, UTC date window, measurement granularity, measured value,
  optional model/platform/feature dimensions, stable event ID, and capture time.
* `unified_usage_sync_runs`: per-account source, start/end timestamps, outcome,
  number of inserted/corrected observations, and error text.
* `unified_usage_account_links`: one analytics account ID and one unique original
  manager account ID. This installation-local mapping contains no credentials.

Foreign keys cascade on explicit account deletion. Disconnecting retains history.
Both v24-to-v25 and v25-to-v26 run in the existing migration savepoint. Existing tables
are not rewritten. The normal pre-migration backup remains available. To roll
back to an older application, restore the pre-upgrade database backup; do not
simply lower `PRAGMA user_version`. The old binary deliberately refuses newer
database versions.

New analytics tables are excluded from WebDAV/S3 configuration snapshots and
preserved during configuration restore. This prevents one computer's
configuration import from replacing another's private analytics history. The
explicit analytics JSON export/import transfers data without credentials or local
authentication links. `linkedAccountId` is omitted entirely from that portable
format; restoring it creates disconnected, unlinked profiles. Restoring a JSON
backup cannot overwrite an existing local authentication mapping. A full CC Switch
SQL backup also includes the analytics tables as an installation backup.

## Measurement and deduplication

The official adapter stores service-reported daily token buckets as daily
snapshots under `codex_account_activity`, source `codex_app_server`, metric/unit
`tokens`, provenance `official`. Model, platform, feature and reasoning mode stay
unavailable when the service does not report them. A lifetime summary is kept on
the account and is never added to daily totals.

The canonical daily key hashes a JSON tuple of account, source, scope, metric,
unit, provenance, day and dimensions. An updated bucket replaces its previous
value instead of increasing it. A stable event key uses account, source, scope,
metric, unit, provenance and event ID; date or dimension corrections update the
same record. Newer capture timestamps win. Even unchanged values advance their
watermark so an older correction cannot overwrite a fresher observation.
Importing daily snapshots and individual events for the same coverage set/day
is rejected. Different sources and scopes remain distinct; overlap without a
stable correspondence is never resolved by adding both totals.

ChatGPT `conversations.json` imports count user-authored message IDs with valid
timestamps under `chatgpt_export_activity`. Counts are locally derived from
the export (`local` provenance), not service-reported tokens. Export identity
cannot be verified, so the user assigns the original account. Message text,
titles, files, audio, images and conversation bodies are not stored. Missing
IDs/timestamps are skipped with a warning. The importer does not guess model,
feature-specific resource cost or device from undocumented metadata.

Custom observations require source `imported_usage`, an explicit
`imported:<namespace>` scope, and `local` or `estimated` provenance. The namespace
must describe a single disjoint coverage set. Do not import both a total and its
component breakdown as independent observations in the same namespace. Records
without a stable event ID must be final daily snapshots. Arbitrary custom imports
cannot claim verified official provenance. Backups preserve their declared
provenance, with an explicit warning that restored data is not independently
reverified.

All queries group by account, source, scope, metric, unit and provenance. A
dashboard may combine matching groups across different accounts, but never token
counts, message counts, quota percentages, lifetime counters or estimates across
different coverage sets. Values must be finite and nonnegative. Count units must
be whole numbers. Values and grouped sums exceeding JavaScript's exact numeric
range are refused. Empty datasets are displayed as unavailable; they are not
populated with demonstration values.

## Synchronization and failure recovery

Refresh is manual by default. A configurable interval is stored per account
(manual, or 5–1440 minutes). Automatic reads are driven only while the analytics
view is visible; there is no continuously running account-polling daemon. A
per-profile command lock serializes refresh, account changes and disconnect.
Browser login remains cancellable while waiting. A completed login must still
find its account in the pending state before binding it, preventing stale login
completion from reviving a removed/disconnected profile.

Each account is processed independently. Usage and quota RPC calls are independent
so unavailable token activity does not hide an available quota response. Failed
refreshes retain the last good history and snapshots with their timestamps.
Authentication failures become `reauth_required`; unsupported methods and network
errors are reported without substituting fabricated values. On restart,
unfinished sync runs become `interrupted`; retrying is idempotent. JSON imports
are transactional and bounded to 128 MiB per file. ZIP exports must be extracted
first. Heavy reads/parsing run in the blocking pool, off the UI thread.

Restored profiles are disconnected, preserve stale snapshots/settings, and require
fresh authorization. Only recognized numeric summary fields and documented quota
fields are retained; arbitrary backup metadata is not copied to those snapshots.

## Preserving custom features across upstream releases

Upstream release detection remains read-only. `services/unified_updates.rs` records
the detected version and manages a finite local preparation job. It does not
download or install stock release binaries. The native stock installer, portable
stock download, and generic stock-update fallback commands reject replacement
before any download, cleanup or restart. Frontend updater permissions permit
checking only, so direct JavaScript download/install calls are unavailable.
The database-recovery check does not suggest a stock update as a compatible
recovery candidate for this custom database.

The user selects a custom source directory containing the matching edition
manifest and maintenance script. Device-local settings and the small job-status
file live under the CC Switch configuration directory's `unified-updates` folder;
bulk source worktrees and build artifacts live in the operating-system cache at
`cc-switch-unified-updates/jobs/<UUID>`. They are separate from account/configuration
cloud synchronization. Automatic preparation is disabled until a source directory
is configured and the user enables it. No hosted signed custom-update channel is
invented or assumed to exist.

When enabled, detection launches `node scripts/maintain-upstream.mjs` with explicit
argument values, an isolated job directory and `--build`. Only one preparation job
runs at a time. It has a 90-minute limit, no visible console, process-tree cleanup
on application exit, an isolated test home, and no inherited model access tokens,
API keys or signing keys. The pipeline merges/ports custom code into a candidate,
checks migration compatibility, runs required tests and builds a new custom
artifact. It never overwrites the running executable or the user's account store.

Merge conflicts or schema ambiguity stop in `conflict` or `migration_review`.
This matters because custom schema versions 25/26 can collide with future upstream
migration numbers: a version-number comparison cannot establish compatibility.
There is no claim that unknown future source changes can always be reconciled
automatically. A candidate becomes `ready` only when the process succeeds and its
bounded result report confirms a native build and every required check passed.
Reported source candidate paths must resolve inside the owning cache job. The UI's
workspace path opens that job root, which contains the binary/source archives,
`result.json`, validation reports and the source candidate; it is also available
after failed preparation for troubleshooting. A visible workspace path does not
mean that the candidate passed checks or was installed. Source-only
preparation cannot be represented as a completed software update. Installation of
the resulting artifact remains a separate user action. Interrupted jobs become a
retryable error on restart; no existing installation is replaced.

## Capability limits

See [source compatibility research](unified-usage-sources.md). Service-reported
account activity is device-independent for the coverage the service reports.
That does not establish an all-ChatGPT ledger for web, Windows, macOS, iOS,
Android, voice, images, uploads, data analysis or every reasoning mode. Those
features may not have an accessible usage metric, and their absence is shown
explicitly. Export message activity and local session/proxy statistics provide
additional separate evidence, not missing consumer token estimates.
