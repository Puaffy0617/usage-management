# Unified account usage analytics

This extension adds **Usage → Account analytics** to CC Switch 4.0.25. The original usage dashboard remains available as **Device activity**, with its provider management, account switching, proxy instrumentation and local session scanner unchanged.

Upstream: <https://github.com/farion1231/cc-switch>, baseline commit `ca58c0313360eae7c851fbd7553c1614c7af03e7`.

## What it collects

Use **Import existing ChatGPT accounts** to link the accounts already saved in this CC Switch installation, or add separate analytics profiles and authorize them through the official browser sign-in. Importing existing accounts does not start a new sign-in, refresh credentials, fetch usage, change the default account or call logout. A current official Codex CLI must be installed and discoverable by CC Switch for usage synchronization. Each analytics profile uses a fixed, separate directory under the CC Switch configuration directory (`usage-codex-profiles/<UUID>`). The collector calls documented Codex App Server methods, rather than private usage endpoints:

- `account/read`: available account identity and subscription metadata.
- `account/usage/read`: available token-activity summary and daily buckets.
- `account/rateLimits/read`: available named quota windows and reset times.

The application only shows data that these calls return. It cannot establish complete consumer ChatGPT history, model attribution, device attribution, reasoning-mode consumption, image counts, voice duration, upload usage or other feature totals from an undifferentiated account token bucket. Missing data is unavailable. The feature does not estimate it from subscription price or conversation length.

See [the compatibility assessment](unified-usage-sources.md) for all requested platforms, official sources, authorization boundaries and dated research links. API organization usage and eligible workspace admin analytics are separate reporting scopes and are documented as researched but not integrated.

The v2 account view adds API-equivalent CNY estimates, measured-token/request/cache cards, a UTC daily heatmap and account/model/day tables. Costs require exact model prices and explicit compatible token components; unavailable amounts stay unavailable. See [the cost and automatic-refresh guide](unified-usage-costs.md) (Chinese). These estimates are not subscription charges.

## Architecture and data integrity

The frontend uses the application's React components, TanStack Query, design tokens and Recharts. `UsagePage.tsx` selects the existing device dashboard or the additive `UnifiedUsageDashboard.tsx`. `src/lib/api/unifiedUsage.ts` provides typed Tauri command calls.

The Rust command layer in `commands/unified_usage.rs` validates input and coordinates the account lifecycle. `services/unified_usage_codex.rs` owns the documented JSONL App Server adapter and bounded child processes. `services/unified_usage.rs` owns persistent metadata, observation validation, aggregation, import/export and sync history. A source adapter returns observations with account, source, scope, metric, unit, provenance, period, dimensions and a stable event identifier when available. New adapters should emit the same metadata instead of adding special cases to the charts.

Schemas v25 and v26 are additive. `database/unified_usage_v25.sql` adds account, observation and synchronization-history tables; `database/unified_usage_v26.sql` adds nonsecret links to original CC Switch accounts. Existing provider and usage tables are untouched. Existing pre-migration database backups apply. The analytics tables are preserved locally during configuration cloud synchronization; credentials and authorization links are excluded from portable analytics JSON exports. Moving metadata to another computer requires linking or authorizing accounts on that computer.

Daily official buckets are snapshots, not increments. Their deterministic identifier includes the account, source, metric, scope, date and dimensions. Refreshing the same bucket replaces its value, including upstream corrections. Lifetime summaries and quota snapshots are kept outside daily totals. Historical buckets are retained when the next response supplies less history. Event imports require stable IDs; source identity determines which events can safely be deduplicated. Unknown overlap cannot be solved by hashing similar timestamps, so different scopes remain separate.

Aggregations group by source, scope, metric, unit and provenance. Only matching groups across distinct accounts are added. Official measurements, local measurements and estimates retain separate totals. Imported files retain their declared provenance; importing a file does not certify that its claims are accurate. Existing local logs cannot safely be assigned to the account currently selected, because they did not record that identity at capture time.

Automatic sync is enabled by default every two minutes while the analytics page is open, visible and focused. Account management can disable it or choose a one-, two- or five-minute interval. The header's **Sync now** refreshes every connected analytics account, including accounts not currently in use, even while a single account is selected for display. A row's refresh targets only that account. Both automatic and global manual refresh consider every eligible profile independently of the display filter. The collector never chooses the current provider or the ordinary Codex login. Transient failures retry at the configured interval, while expired authorization requires reconnecting.

Accounts fail independently; a failure preserves existing historical records and records its status. No persistent background daemon or unrestricted polling is introduced. Interrupted sync runs are marked on database startup. Quota snapshots show their capture time and must not be read as a guaranteed current allowance after a disconnect.

Available credit balances, unlimited-credit flags and earned-reset counts are displayed separately from quota windows. Summary fields are retained service snapshots, including peak daily tokens, streaks and the longest turn when reported; they can be older than the latest partial synchronization.

## Security

Separately authorized analytics profiles force `cli_auth_credentials_store="keyring"`; they fail when the OS credential store is unavailable, without a plaintext fallback. Do not rename those profile directories after sign-in: the verified Codex client derives its credential-store key from the canonical profile path.

Imported accounts keep the original CC Switch manager as their sole credential and refresh owner. Import reads only the manager's public account metadata. Later synchronization obtains a short-lived access token through that manager's normal lifecycle and uses the documented experimental `chatgptAuthTokens` App Server flow with **ephemeral** credential storage. Refresh tokens and ID tokens are not copied into analytics profiles or databases. The existing manager retains its original credential storage; this feature does not rewrite legacy credentials into a different storage system. A rejected external access token fails without deleting the original sign-in or creating a competing refresh-token chain.

**Unlink analytics** stops an imported account's analytics subscription and retains its history; **Remove** removes only that analytics profile and history. Neither action removes the original provider account, changes provider bindings/defaults, or invokes logout on the original session. Importing again explicitly reactivates the same linked profile. Expired original sessions must be reauthorized from the existing **Accounts** panel; analytics does not force a logout or start a replacement login.

Analytics never asks for a password, extracts browser cookies, or stores tokens in its database. Existing provider sign-ins and active-provider switching continue through the original manager.

Keep analytics exports private: they contain account identifiers and usage history, although they exclude credentials and conversation bodies. A user-selected ChatGPT `conversations.json` can be processed for limited conversation/message activity metadata; its contents are not a token or quota ledger, and raw message text is not retained. ZIP extraction is deliberately unnecessary: select the extracted JSON file.

## Installation and Windows build

An unsigned Windows x64 portable debug build is supplied separately. Extract the complete ZIP, including `WebView2Loader.dll`, and **exit the currently running CC Switch process** before launching it. Exiting the program does not mean signing out. Both builds use the same application identity and configured data directory, so existing accounts, provider bindings and saved sign-ins carry over on the same computer. Do not delete or overwrite that configuration folder. This build was not installed over the existing application. If the original installation used a custom or portable data folder, select that same folder in the new build. Live validation still requires access to the two actual accounts, through their retained sessions or separate authorization.

1. Extract the complete modified source archive to a stable directory.
2. Install Node.js 22.12 or newer, the repository-pinned pnpm 10.12.3, Rust 1.95, and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/): Microsoft C++ Build Tools with the Desktop development with C++ workload, Windows SDK and WebView2.
3. In the repository root run `corepack pnpm install --frozen-lockfile`, then `corepack pnpm typecheck` and `corepack pnpm build:renderer`.
4. Run `corepack pnpm dev` for the native development application.
5. For an unsigned local installer, create `local-build.json` containing `{"bundle":{"createUpdaterArtifacts":false}}`, then run `corepack pnpm tauri build -c local-build.json`. The release signing key is not needed for this local build configuration.
6. Install a current official Codex CLI and verify `codex --version`. Open **Usage → Account analytics**, click **Import existing ChatGPT accounts**, then **Sync now**. Both stored accounts are linked, independently of the current provider/default account. For accounts not already stored in CC Switch, use **Add account** and authorize separately. Check each displayed identity before reviewing combined compatible metrics.

The source also includes Windows/macOS/Linux upstream packaging configurations. Each platform needs its normal Tauri build prerequisites.

## Following official CC Switch updates

This custom edition checks official releases as **advisories**. Stock upstream installers and portable download actions are blocked in the native backend, and the frontend updater capability is limited to checking. This prevents an official binary from silently replacing custom account analytics. The database-recovery screen also requires a compatible custom build.

The hosted edition pins [Puaffy0617/usage-management](https://github.com/Puaffy0617/usage-management) and a dedicated verification key. After the first manual installation, it checks custom releases at startup and every six visible hours, then offers an explicit **verify, install and restart** action in Settings → About. The hosted Windows workflow builds and tests without signing credentials, then signs verified installer artifacts in a separate job. See [the signed release guide](hosted-releases.md).

Local source preparation also remains available. In **Settings → About → Custom update compatibility**, choose the complete extracted custom source directory and enable **Prepare detected upstream updates automatically**. With Git, Node/Corepack/pnpm and the Windows Rust/MSVC build prerequisites installed, a detected newer stable release starts an isolated merge → migration review → tests → native build job. Successful jobs produce new custom program/source ZIPs in a device-local cache directory. A failed merge, test or schema review preserves the currently installed application and data. This local workflow does not automatically replace or launch the candidate.

Original account metadata is discovered at startup, when analytics accounts are listed, and after successful original ChatGPT account authorization. Discovery adds new source accounts without refreshing credentials, resetting existing names/history/errors, or reactivating deliberately disconnected subscriptions. Removing a linked analytics profile records a nonsecret exclusion, so automatic discovery does not recreate it; explicit **Import existing ChatGPT accounts** can restore that subscription. Original provider accounts stay signed in throughout these metadata operations.

See [the update workflow guide](unified-updates.md) for prerequisites, local commands, repository CI and the upstream-schema compatibility gate.

## Verification and limitations

See [the validation report](unified-usage-testing.md) for commands actually run, results and outstanding live checks. Automated test fixtures are confined to tests; the application starts without fabricated accounts or statistics.

Live acceptance requires two real linked or separately authorized accounts. Those live sessions were not used during development. Confirm each account's returned bucket values and quota against its official client, repeat synchronization, restart the application and verify history is retained, then unlink one imported account and verify its original provider account remains signed in and the other's statistics remain available. Some optional fields may never be returned for a particular account. Unsupported App Server methods should prompt a CLI upgrade or display unavailability, never trigger a private-usage-endpoint fallback.

To roll back application code, restore a database backup from before that schema upgrade before launching the older application. Do not lower `PRAGMA user_version` on a populated database. Export analytics metadata first if it should be retained. Removing an imported analytics profile leaves the original account signed in. Separately authorized analytics profiles use their own secure-store session and can be disconnected independently.
