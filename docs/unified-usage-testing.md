# Unified usage validation

Validation date: 2026-11-05. Upstream baseline: `ca58c0313360eae7c851fbd7553c1614c7af03e7`.

## Revision usage.3 verification

The new native focus/status and thread-panel checks passed 30 frontend tests; TypeScript and the production renderer passed. The exact production-source core harness passed 67 tests. A later unavailable-thread cooldown boundary change passed all four filtered store tests (64 other tests filtered); these counts overlap and are not additive. The 26 Node maintenance/signing/bootstrap tests passed with schema 27 included in the mandatory hosted migration gates. Isolated headless UI checks at 1800×1180 and 1280×900 verified persistent success/pause status, exact token totals, separate cumulative thread model/USD snapshots, cross-account ambiguity handling and all-account synchronization under an individual display filter, with no browser errors or external network requests. The screen fixtures are explicitly synthetic.

## Revision usage.4 verification

The locked production-source harness passed 83 tests, including the application-lifetime background policy, shared batch coordination, safe native launcher resolution and an actual isolated Windows child with no console window. A metadata-only invocation of the exact resolver accepted the installed npm Codex package with matching host architecture and version; Codex itself and real authentication/API requests were not executed. Native command/AppState integration passed complete Windows GNU Clippy with warnings denied.

The background controls, first-screen monetary/token summary and thread view passed 36 frontend tests. Price maintenance and conservative catalog merging passed 24 tests, including background checks without a visible page, overlapping-request coalescing, refreshing older configured models, preserving omitted rates and rejecting false-zero underflow. TypeScript and the production renderer passed. Isolated headless UI checks verified both window sizes, stored-data-only UI polling, separate financial coverage and all-account manual synchronization. Full current-version CI and required MSVC release checks are recorded in each release's build metadata.

Native tests cover bounded fresh-process transport recovery, authentication classification, partial-result preservation, three-ID request limits, per-thread request/collection budgets, missing and unsafe numeric fields, metadata-only candidate discovery, replacement/stale snapshots, cooldown/queue fairness, shared thread contexts, deletion isolation and additive schema 27 migration/backup fixtures. The normal CI and hosted release publish their actual complete check results. Runtime availability of the per-thread billing response for a particular real account still requires an actual response; protocol fixtures do not establish that availability.

## Results

| Check                                                     | Result                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend TypeScript strict check                          | Passed                                                                                                                                                                                                       |
| Production renderer build                                 | Passed; existing large-chunk and browser-database age warnings                                                                                                                                               |
| Complete v2 frontend suite                                | 3,639 passed across 286 files; includes the 41 cost/helper/FX tests                                                                                                                                          |
| Later v2 account-view and heatmap regressions             | 19 dashboard and 5 overview tests passed after the full run; overlapping checks, not additive                                                                                                                |
| Cost normalization and pricing/FX hook                    | 41 passed; included in the full frontend suite                                                                                                                                                               |
| Historical v1 hosted startup checks                       | 4 passed; disabled channel, cached notification, offline startup and visible polling; included in later complete runs                                                                                        |
| Historical v1 selected analytics/updater frontend tests   | 53 passed; overlaps later complete runs                                                                                                                                                                      |
| Historical existing UsagePage/dashboard/trend checks      | 52 passed; existing React `act` warnings; overlaps later complete runs                                                                                                                                       |
| Changed-file Prettier check                               | Passed                                                                                                                                                                                                       |
| `git diff --check`                                        | Passed                                                                                                                                                                                                       |
| Official installed Codex 0.166.0 signed-out handshake     | Passed in a newly created isolated profile; no actual sign-in attempted                                                                                                                                      |
| Complete Rust/Tauri compilation check                     | Passed with Rust 1.95 and a portable Windows GNU toolchain                                                                                                                                                   |
| Backend production-source tests and persistence harness   | 45 passed, including complete filtered usage buckets and version-bound signed-update verification                                                                                                            |
| Maintenance pipeline offline Git fixtures                 | 11 passed; actual three-way source merges, conflict/schema guards, output isolation and ready-state restrictions                                                                                             |
| Windows x64 debug executable                              | Built successfully with embedded renderer and WebView2 loader; unsigned portable build                                                                                                                       |
| Native UI smoke check                                     | Isolated test instance launched; existing device view, empty account dashboard and Add account dialog rendered correctly. User stopped Computer Use before profile creation; further UI interaction stopped. |
| Existing-account import safety                            | Passed metadata/idempotency/unlink/reimport/removal tests and external-token RPC tests; no original-account logout or copied refresh-token flow                                                              |
| Live authorization and usage reads from two real accounts | Not run: the user's live credential store was not accessed during validation                                                                                                                                 |
| Published v1 signed Windows installer                     | Real MSVC hosted build, all required native gates and publication passed; independently checked public signature/version binding and rejected tampering                                                      |
| v1 normal cross-platform CI                               | All platform jobs passed in run 41991004713                                                                                                                                                                  |
| v2 hosted Windows release                                 | Pending at this documentation update; local frontend/core results are not a hosted installer or installed-upgrade acceptance                                                                                 |

The signed-out smoke sent `initialize`, `initialized`, then `account/read` to the actual official CLI. The server returned a signed-out account and an authentication requirement. The process stopped successfully, no plaintext `auth.json` was created, and the user's regular Codex profile was not accessed. This validates transport and isolation, not authorized account data availability or OS keyring persistence after sign-in.

## Reproducible checks

The separate hosted-signing and release-bootstrap suites passed 15 Node tests (ten signing/workflow fixtures and five bootstrap tests), in addition to the 11 maintenance Git fixtures: 26 total. The Google OAuth configuration test compiled locally, but the full GNU Tauri test executable could not start because of a Windows loader entry-point error. The real [v1 MSVC hosted run 41986846474](https://github.com/Puaffy0617/usage-management/actions/runs/41986846474) passed that exact required test and all other native release gates, then published the signed installer. The [normal CI run 41991004713](https://github.com/Puaffy0617/usage-management/actions/runs/41991004713) also passed all platform jobs. Independent verification of the public v1 installer accepted the expected key/version and rejected altered payloads and wrong versions. These v1 results do not establish a v2 build result or a live-account upgrade.

Use the repository-pinned pnpm version. The development machine's pnpm shim attempted to migrate build-script policy, so validation invoked the installed binaries directly after restoring the upstream workspace configuration:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node node_modules/vitest/vitest.mjs run tests/components/UnifiedUsageDashboard.test.tsx tests/components/unifiedUsageData.test.ts --maxWorkers=2 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/lib/unifiedUsageCost.test.ts tests/hooks/useUnifiedUsagePricing.test.tsx tests/components/UnifiedUsageOverview.test.tsx --maxWorkers=2 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/components/UsagePage.test.tsx tests/components/UsageDashboard.test.tsx tests/components/UsageDashboard.smoke.test.tsx tests/components/UsageTrendChart.test.ts tests/components/UsageTrendChart.render.test.tsx --maxWorkers=2 --minWorkers=1
git diff --check
```

Backend production unit tests are in the new service modules. A small reproducible harness in `tests/unified-usage-core` compiles those **exact source files**, using test-only Database/error/configuration plumbing and a tool locator that refuses to launch a real Codex account. It also runs persistence checks against a temporary SQLite file. It is not a replacement for compiling and running the complete Tauri application:

```powershell
cargo test --locked --manifest-path tests/unified-usage-core/Cargo.toml
```

The development machine lacked the MSVC linker. Validation used a portable Rust 1.95 GNU toolchain and genuine MinGW GCC. For the standalone production-source harness, `RUSTFLAGS="-C link-self-contained=yes"` was required to use the Rust toolchain's matching CRT objects; attempts without it crashed before entering tests. With matching objects, all 45 current harness tests passed. This environment correction did not change application code. The complete Tauri application also passed `cargo check --locked` with the GNU toolchain. The separate full Tauri test executable later encountered the loader limitation noted above; hosted MSVC execution supplies that native-test evidence. Normal MSVC builds use the standard commands above without this GNU-specific setting.

For the portable desktop executable, the local toolchain's pthread archive was aligned with MinGW's native C libraries to resolve `nanosleep64`. The backend tests were rerun successfully after that alignment. The upstream build script also passed MSVC-only manifest flags to GNU; the added target-environment guard preserves those flags for MSVC and lets Tauri handle the GNU application manifest. The final executable was built with the ordinary CC Switch application identifier. Earlier UI smoke testing used a separate test identifier and isolated `CC_SWITCH_TEST_HOME` so the already-running installed application and its data were not used for that check. Computer Use was not resumed for the subsequent existing-account import update.

The complete v2 frontend run passed **3,639 tests across 286 files**, including all **41 cost-helper and pricing/FX-hook tests**. After that run, the dashboard suite passed 19 tests (including two new family-ranking/lifetime regressions), and the overview suite passed five (including a new UTC-midnight regression). These selected runs overlap the full suite and must not be added to its count. The production-source Rust harness passed **45 tests**. Maintenance Git, bootstrap-configuration and hosted-signing fixtures run separately under Node's test runner.

Cost fixtures check inclusive-versus-fresh input semantics, cached-token normalization, per-model pricing/manual overrides, two-account sums, missing models/components/prices/FX, partial coverage, unknown metrics, numeric underflow, model-less summaries and ambiguous dimensions. Pricing/FX-hook fixtures use a controlled clock and mocked public responses to check daily visible-only refresh, retained stale quotes with attribution, and no static FX fallback. UI fixtures verify source/scope family selection, reported metrics, UTC dates, partial/unavailable formatting, and refresh of both eligible accounts regardless of the selected display filter. None of these fixtures use real accounts or prove complete consumer-product coverage. See [the v2 cost guide](unified-usage-costs.md).

Existing-account coverage checks importing two accounts, duplicate prevention, reimporting an unsubscribed profile, retaining history and names, preserving the immutable original metadata, excluding credential links from portable JSON backups, and removing only analytics records. Protocol replay checks external access-token authorization, absence of refresh/id tokens, read without client-managed refresh, and process termination without `account/logout`, including on rejected authorization. A read-only code audit confirms the native import calls only `CodexOAuthManager::list_accounts`, which clones/sorts metadata without token resolution, network access, default-account mutation or persistence. Later Sync uses the original manager's normal refresh lifecycle as the single owner.

Update-specific tests verify that stock installation cannot be entered from portable/nonportable About paths, update-check errors, or database recovery; upstream detection remains advisory and queues only the native compatibility policy. Backend tests cover version/source validation, one-job-at-a-time execution, interrupted-job recovery, result containment and rejection of falsely ready/unbuilt candidates. Signed-channel tests verify exact repository/key/version pins, same-manifest review, payload and trusted-version signatures, tampering and replay rejection, and no fallback. Account discovery tests preserve disconnected and removed subscriptions across restart while adding genuinely new accounts. The Node fixtures execute actual Git three-way applications in synthetic local repositories, checking clean merges, conflicts, obsolete deletions, upstream schema changes, updater permissions, source/output boundaries and machine-readable failures. They do not prove that an arbitrary future official release will merge or build. Hosted builds publish their actual checks and installer hashes as release metadata; a successful build is not an installed-upgrade or live two-account acceptance test. Unattended installation and real-account validation remain unperformed.

With normal Windows Tauri prerequisites installed:

```powershell
New-Item -ItemType Directory -Force dist
$env:CC_SWITCH_TEST_HOME = Join-Path $env:TEMP ('cc-switch-test-' + [guid]::NewGuid())
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml unified_usage
```

Do not run general upstream backend tests against your regular application data. The temporary test-home setting above isolates tests that use upstream filesystem helpers.

## Requested acceptance cases

| Scenario                | Automated coverage                                                                             | Remaining live check                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Two separate accounts   | Database identity and separation; import both original profiles; authorization protocol replay | Link both real original accounts, or authorize separate profiles                  |
| Collect from both       | Nullable daily snapshots and separate account records                                          | Verify actual service responses for each plan                                     |
| Combined usage          | Matching metric/scope/provenance grouping and unsafe-number guard                              | Compare returned daily buckets against official client                            |
| Individual statistics   | Account filter and comparison rendering                                                        | Inspect each real account                                                         |
| Switch selected account | Account-filter data contract; existing usage view tests                                        | Check native selection with real profiles                                         |
| Historical sync         | Corrected snapshots, stable IDs, retained history and backup restore                           | Check service's available historical range                                        |
| Unavailable source      | Null fields, unsupported RPC methods and partial quota success                                 | Check unavailable/older client behavior in native app                             |
| Duplicate prevention    | Repeated import, snapshot replacement, moved stable events, overlap rejection                  | Refresh the same real accounts repeatedly                                         |
| Expired authentication  | Replayed sign-in failure/cancellation and retained reauth status                               | Validate with a disposable test session; original accounts need not be signed out |
| Restart persistence     | Reopen temporary SQLite file, preserve two profiles/history, recover interrupted run           | Restart the packaged desktop app with real keyring logins                         |

## Limits of this validation

Test fixtures exist only in tests. They are not seeded into the application, substituted for unavailable service results, or presented as the user's usage.

Live OAuth success, secure-store persistence across a native application restart, actual consumer product coverage, and account-specific history availability require user authorization. No test can turn an undocumented feature breakdown into a measured one. The compatibility document distinguishes supported methods from unverified coverage and unsupported sources.
