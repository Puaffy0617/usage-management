# Isolated production-source verification

Run from the repository root:

```sh
cargo test --manifest-path tests/unified-usage-core/Cargo.toml
```

This harness compiles the **actual production files**
`src-tauri/src/services/unified_usage.rs` and `unified_usage_codex.rs` by path. It
does not copy or reimplement their analytics or protocol logic. It supplies only
small database/error/configuration/tool-locator stubs so these modules can be
tested without Tauri, WebView or the full desktop build environment.

Tests cover two-account aggregation, persistence after restart, interrupted
synchronization recovery, identity conflicts, stable event/daily snapshot
deduplication and correction, unavailable metrics, separate units/scopes,
transactional imports, bounded numeric aggregation, sanitized backups, and replay
of the official app-server JSON-RPC protocol and cancellation/timeout handling.

The tool-locator stub rejects real process execution. Protocol tests use in-memory
duplex streams, and database tests use memory or disposable temporary directories.
The harness does not access real credentials, user conversations or authenticated
accounts. Test fixtures are synthetic inputs used only in tests and are never
displayed by the application.

This is **not a full Tauri integration test**. Native command registration,
operating-system keyring behavior, browser sign-in, actual service responses and
two real ChatGPT accounts require testing the built desktop application. A
successful harness run cannot substitute for that live verification.
