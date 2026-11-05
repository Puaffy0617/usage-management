# Keeping the customized edition current

The official CC Switch updater distributes the official application. Installing that binary can replace this edition's analytics code. Keeping the database alone does not preserve a feature that is absent from the installed executable.

This edition includes a source integration pipeline. It detects or accepts an official stable release, reapplies the customization, runs checks and builds a separate Windows candidate. Local preparation never replaces the running application. A separate configured hosted workflow can sign and publish passing custom Windows installers. Arbitrary upstream changes cannot be guaranteed to merge unattended.

## Local build requirements

Use Windows with Git, Node.js 20.19+ and Corepack/pnpm, Rust 1.95, Microsoft C++ Build Tools, the Windows SDK and Microsoft Edge WebView2 Runtime. These are the native Tauri/MSVC requirements; a user-facing build attempt reports missing prerequisites instead of returning a fake successful candidate. Network access is required for the official source and build dependencies. Source integration can consume the complete delivered source ZIP without a `.git` directory.

Run from the extracted source directory, replacing the version and output path:

```powershell
node scripts/maintain-upstream.mjs --target-version 4.0.26 --output C:\CCSwitchBuilds\update-job-001 --build
```

`4.0.26` is an example syntax, not a claim that this release exists. The requested version must be a published official stable release newer than the pinned upstream baseline. The output directory must be new and empty, outside the source directory, and must not contain the source directory. Use a distinct job directory for every attempt. The script does not recursively delete existing directories.

## What the pipeline preserves and checks

`customization/upstream.json` records the official repository, baseline commit and version, upstream schema version, customization schema version, application identifier and explicit customization file list. The complete delivery populates that list. Only these listed source files are overlaid on an official baseline; authentication files, databases, environment files, generated dependency directories and symlinked source paths are refused.

The pipeline uses a full-index binary patch and [Git's three-way application](https://git-scm.com/docs/git-apply#Documentation/git-apply.txt--3way) in [separate worktrees](https://git-scm.com/docs/git-worktree). It preserves the current checkout and never reads the user's CC Switch database, browser cookies, conversation records or normal Codex profile.

Before applying the patch, it independently reads the target release's upstream `SCHEMA_VERSION`. The original baseline is schema **24**, and this customization adds **25, 26 and 27**. If a future official release changes the upstream schema, the job returns **migration_review** before patching. A source merge alone cannot prove that two independently numbered database migrations are compatible. The migration definitions and integration baseline must be reviewed and updated before a candidate can be built.

After a clean merge, checks verify the application identifier, required analytics files, command/navigation integration, customization schema and unsigned-build configuration. Every capability file is checked: the stock updater may check for upstream releases but cannot download or install them. Mandatory validation includes the maintenance Git fixtures, TypeScript checking, frontend tests, renderer build, standalone analytics Rust tests, native Rust checking, native analytics and updater-policy tests, and both new native migration tests. Windows builds use the MSVC target and two Cargo build jobs. Analytics tests receive a disposable `CC_SWITCH_TEST_HOME` and isolated `CODEX_HOME`; they do not authenticate real accounts.

Only after every check and the native build succeeds does the job return `phase: "ready"`, `built: true`, successful `nativeBuild` evidence and passing checks. A source-only preparation cannot report a ready application. The packaged Windows ZIP contains the executable, matching WebView2 loader, license and instructions. A separate ZIP contains tracked source, with its upstream baseline advanced to the integrated release and customization file list refreshed against that release. Neither package includes user data or credentials.

## Results and manual installation

Every ordinary completed attempt writes `result.json` in the job directory. The application can inspect these states:

| Phase              | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `ready`            | Native custom candidate built, checks passed and packages created            |
| `conflict`         | Source changes overlap; inspect the isolated candidate and resolve them      |
| `migration_review` | Upstream database changes require explicit migration reconciliation          |
| `error`            | Prerequisites, release lookup, source validation, checks or packaging failed |

Failure leaves the installed application and local account database alone. A failed check does not produce an installable candidate. Review the result and artifacts before replacing program files. Close CC Switch, keep `cc-switch.exe` beside `WebView2Loader.dll`, and retain the existing application identifier and data location. A candidate is unsigned unless a maintainer separately configures signing. Database backups remain necessary when installing reviewed migration changes; old binaries should not be pointed at a newer schema without a verified rollback plan.

After installing a reviewed candidate, extract its matching source ZIP to a stable directory and select that directory as the customization source for subsequent builds. This retains reviewed conflict resolutions and the advanced upstream baseline. Do not point the builder at ordinary official source that lacks the customization manifest and feature files.

Accounts are not packaged or copied into the new executable. The existing CC Switch database stays in its existing directory. Imported accounts retain the original credential manager and its existing storage; separately authorized analytics profiles use the operating system credential store, keyed to their original isolated profile paths. Moving application data or isolated profiles to another computer can require reauthorization. No update pipeline can guarantee authentication remains valid after provider revocation or expiry.

## Repository CI and signed releases

`.github/workflows/unified-upstream.yml` checks weekly and supports a manual target version. The configured public repository is [Puaffy0617/usage-management](https://github.com/Puaffy0617/usage-management). [GitHub Actions schedules and manual triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) run in that repository. Unconfigured source copies retain the artifact-only local preparation path.

The hosted workflow `.github/workflows/unified-hosted-release.yml` runs the same merge/schema/test gates, builds a Windows NSIS installer without a signing key, and uploads immutable inputs. A separate trusted job verifies source/version/key/repository metadata and hashes, signs the installer with a protected Actions Secret, verifies the signature and signed app version, and publishes a stable custom release and `latest.json`. Only the publication job receives repository write permission. It does not push source commits, post messages or install the application on the user's computer. Already published upstream/custom version pairs are skipped rather than rebuilt weekly.

The client pins this public custom repository and its dedicated public key. Its generic updater capability remains check-only; installation uses a separate native command that validates the channel and recently reviewed manifest, verifies the signed payload/version, and preserves the existing shutdown/restart lifecycle. There is no runtime field for an arbitrary URL, replacement key or GitHub token. Installation remains an explicit user action. The original signing channel cannot supply this customized binary. See [the hosted release guide](hosted-releases.md) for bootstrap and key maintenance.

The offline regression suite is:

```powershell
node --test tests/maintenance/maintain-upstream.test.mjs
```

Its synthetic Git histories test an actual clean three-way merge, merge conflicts, the upstream migration gate, source-ZIP operation, private-data exclusion, failure results and refusal to label an unbuilt source tree as ready. These fixtures do not establish that an unreleased future upstream version will merge, build or preserve every behavior.
