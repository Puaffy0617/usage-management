#!/usr/bin/env node
// Builds reviewable update candidates. Never installs an app or opens user data.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  normalizeHostedOverlay,
  advanceHostedCandidate,
} from "./hosted-release-lib.mjs";

export const OFFICIAL_REPOSITORY =
  "https://github.com/farion1231/cc-switch.git";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANIFEST = "customization/upstream.json";
const REQUIRED_FILES = [
  "src-tauri/src/services/unified_usage.rs",
  "src-tauri/src/services/unified_usage_codex.rs",
  "src-tauri/src/commands/unified_usage.rs",
  "src-tauri/src/database/unified_usage_v25.sql",
  "src-tauri/src/database/unified_usage_v26.sql",
  "src/components/usage/UnifiedUsageDashboard.tsx",
  "src/lib/api/unifiedUsage.ts",
  "tests/unified-usage-core/Cargo.toml",
];

export class MaintenanceError extends Error {
  constructor(phase, message) {
    super(message);
    this.phase = phase;
  }
}

export function isNewerVersion(target, current) {
  if (!VERSION.test(target) || !VERSION.test(current)) return false;
  const left = target.split(".").map(BigInt),
    right = current.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function run(program, args, options = {}) {
  const { cwd, env, allowFailure = false } = options;
  // On Windows only the fixed corepack invocation needs cmd.exe. No input,
  // release tag, path or user-provided string is interpolated into that shell.
  const shell = process.platform === "win32" && program === "corepack";
  let childEnv = env ?? process.env;
  if (program === "git") {
    childEnv = Object.fromEntries(
      Object.entries(childEnv).filter(
        ([name]) => !name.toUpperCase().startsWith("GIT_"),
      ),
    );
    Object.assign(childEnv, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
  }
  const result = spawnSync(program, args, {
    cwd,
    env: childEnv,
    shell,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 45 * 60 * 1000,
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new MaintenanceError(
      "error",
      `${program} ${args[0] ?? ""} failed. ${result.error?.message ?? result.stderr?.slice(-4000) ?? ""}`,
    );
  }
  return result;
}

function git(cwd, ...args) {
  return run(
    "git",
    ["-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd },
  ).stdout.trim();
}

export function schemaVersion(text) {
  const match = text.match(
    /\bconst\s+SCHEMA_VERSION\s*:\s*i32\s*=\s*(\d+)\s*;/,
  );
  return match ? Number(match[1]) : null;
}

export function validateCustomPath(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.@/-]+$/.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    /(?:^|\/)(?:\.git|\.codex|\.cc-switch|node_modules|target|dist|work|outputs)(?:\/|$)/i.test(
      value,
    ) ||
    /(?:^|\/)(?:auth\.json|\.env(?:\..*)?)$/i.test(value) ||
    /\.(?:db|sqlite|sqlite3|pem|key|p12|pfx)$/i.test(value)
  ) {
    throw new MaintenanceError(
      "error",
      "Customization manifest contains an unsafe or private-data path",
    );
  }
  return value;
}

async function readRegularSource(sourceRoot, relative) {
  const components = relative.split("/");
  let current = sourceRoot;
  try {
    for (const component of components) {
      current = path.join(current, component);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new MaintenanceError(
          "error",
          `Customization path is a symlink: ${relative}`,
        );
    }
    const stat = await fs.stat(current);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new MaintenanceError(
        "error",
        `Unsupported customization file: ${relative}`,
      );
    return await fs.readFile(current);
  } catch (error) {
    if (error.code === "ENOENT") return null; // An explicitly listed deletion.
    throw error;
  }
}

async function jsonFile(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function futureRealpath(filename) {
  const missing = [];
  let current = path.resolve(filename);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertOutputBoundary(sourceRoot, output) {
  const source = await fs.realpath(sourceRoot),
    destination = await futureRealpath(output);
  if (containsPath(source, destination) || containsPath(destination, source)) {
    throw new MaintenanceError(
      "error",
      "Source and update output must be separate directories; neither may contain the other",
    );
  }
}

export async function resolveOfficialRelease(version) {
  if (!VERSION.test(version))
    throw new MaintenanceError(
      "error",
      "Target version must be a stable x.y.z release",
    );
  for (const tag of [`v${version}`, version]) {
    const response = await fetch(
      `https://api.github.com/repos/farion1231/cc-switch/releases/tags/${tag}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "cc-switch-unified-usage-maintenance",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (response.status === 404) continue;
    if (!response.ok)
      throw new MaintenanceError(
        "error",
        `Official release lookup failed (${response.status})`,
      );
    const release = await response.json();
    if (release.draft || release.prerelease || release.tag_name !== tag)
      throw new MaintenanceError(
        "error",
        "Target is not an official stable release",
      );
    return { tag };
  }
  throw new MaintenanceError(
    "error",
    "The requested official release was not found",
  );
}

// Exported for offline fixtures using synthetic Git histories. The command-line
// entry point always fixes repository/manifest provenance to official upstream.
export async function prepareSource({
  sourceRoot,
  output,
  manifest,
  targetVersion,
  targetRef,
  repository = OFFICIAL_REPOSITORY,
}) {
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(output))
    throw new MaintenanceError(
      "error",
      "Source and update output paths must be absolute",
    );
  await assertOutputBoundary(sourceRoot, output);
  const outputStat = await fs.lstat(output);
  if (
    !outputStat.isDirectory() ||
    outputStat.isSymbolicLink() ||
    (await fs.readdir(output)).length !== 0
  )
    throw new MaintenanceError(
      "error",
      "Update output must be a new, empty, nonsymlink job directory",
    );
  if (!isNewerVersion(targetVersion, manifest.upstreamVersion))
    throw new MaintenanceError(
      "error",
      "Target must be newer than this customization's upstream baseline; downgrades are refused",
    );
  if (
    !/^[a-f0-9]{40}$/.test(manifest.upstreamSha) ||
    !Number.isInteger(manifest.upstreamSchemaVersion)
  )
    throw new MaintenanceError("error", "Invalid pinned upstream manifest");
  if (!Array.isArray(manifest.customFiles) || !manifest.customFiles.length)
    throw new MaintenanceError(
      "error",
      "Customization file list is missing; use the complete delivered source archive",
    );
  if (
    !new RegExp(`^v?${targetVersion.replaceAll(".", "\\.")}$`).test(targetRef)
  )
    throw new MaintenanceError("error", "Invalid stable release tag");
  const files = [
    ...new Set(manifest.customFiles.map(validateCustomPath)),
  ].sort();
  const repositoryDir = path.join(output, "upstream-repository");
  const baseDir = path.join(output, "customization-base");
  const candidateDir = path.join(output, "candidate");
  await fs.mkdir(repositoryDir);
  git(repositoryDir, "init", "--quiet");
  console.log(
    `Fetching official baseline ${manifest.upstreamSha} and release ${targetRef}`,
  );
  git(
    repositoryDir,
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    repository,
    manifest.upstreamSha,
  );
  git(
    repositoryDir,
    "update-ref",
    "refs/customization/base",
    manifest.upstreamSha,
  );
  git(
    repositoryDir,
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    repository,
    `refs/tags/${targetRef}`,
  );
  const targetSha = git(repositoryDir, "rev-parse", "FETCH_HEAD^{commit}");
  const upstreamSchema = schemaVersion(
    git(repositoryDir, "show", `${targetSha}:src-tauri/src/database/mod.rs`),
  );
  if (upstreamSchema !== manifest.upstreamSchemaVersion) {
    throw new MaintenanceError(
      "migration_review",
      `Upstream schema is ${upstreamSchema ?? "unrecognized"}; this customization reserves schema ${manifest.upstreamSchemaVersion + 1} through ${manifest.customSchemaVersion}. Migration compatibility needs review before integration.`,
    );
  }
  const targetPackage = JSON.parse(
    git(repositoryDir, "show", `${targetSha}:package.json`),
  );
  if (targetPackage.version !== targetVersion)
    throw new MaintenanceError(
      "error",
      "Official tag/package version mismatch",
    );
  git(
    repositoryDir,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    baseDir,
    manifest.upstreamSha,
  );
  for (const relative of files) {
    const content = await readRegularSource(sourceRoot, relative);
    const destination = path.join(baseDir, ...relative.split("/"));
    if (content === null) await fs.rm(destination, { force: true });
    else {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
  }
  // Regenerate hosted version labels after merging, so they do not conflict
  // with each upstream package-version bump.
  await normalizeHostedOverlay(baseDir, manifest.upstreamVersion);
  // Only allowlisted files were overlaid on this pristine official worktree.
  // Staging its complete tree also handles an obsolete deletion whose path is
  // already absent upstream, without a missing-pathspec failure.
  git(baseDir, "add", "--all");
  const patch = run(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      manifest.upstreamSha,
      "--",
    ],
    { cwd: baseDir },
  ).stdout;
  const patchPath = path.join(output, "customization.patch");
  await fs.writeFile(patchPath, patch);
  git(
    repositoryDir,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    candidateDir,
    targetSha,
  );
  if (patch.trim()) {
    const applied = run(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.hooksPath=/dev/null",
        "apply",
        "--3way",
        "--index",
        patchPath,
      ],
      { cwd: candidateDir, allowFailure: true },
    );
    if (
      applied.error ||
      applied.status !== 0 ||
      git(candidateDir, "diff", "--name-only", "--diff-filter=U")
    ) {
      throw new MaintenanceError(
        "conflict",
        "Customization conflicts with the new official source. Inspect the isolated candidate; no application was built or installed.",
      );
    }
  }
  return { candidateDir, targetSha, upstreamSchema, files };
}

export async function verifyUpdaterCapabilities(candidateDir) {
  const directory = path.join(candidateDir, "src-tauri/capabilities");
  let checkAllowed = false;
  for (const filename of (await fs.readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  )) {
    const capability = await jsonFile(path.join(directory, filename));
    for (const entry of capability.permissions ?? []) {
      const identifier = typeof entry === "string" ? entry : entry?.identifier;
      if (identifier === "updater:allow-check") checkAllowed = true;
      else if (
        typeof identifier === "string" &&
        identifier.startsWith("updater:")
      ) {
        throw new MaintenanceError(
          "error",
          "Candidate grants stock updater installation/download permissions; only updater:allow-check is permitted",
        );
      }
    }
  }
  if (!checkAllowed)
    throw new MaintenanceError(
      "error",
      "Candidate lost its check-only upstream update capability",
    );
}

export async function advanceCandidateManifest(
  prepared,
  manifest,
  targetVersion,
) {
  const hostedVersion = await advanceHostedCandidate(
    prepared.candidateDir,
    targetVersion,
  );
  if (hostedVersion)
    git(
      prepared.candidateDir,
      "add",
      "--",
      "package.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
      "customization/release-channel.json",
    );
  // Only the isolated candidate changes. Do this before compilation so its
  // source metadata and the resulting binary describe the same baseline.
  const updated = {
    ...manifest,
    upstreamSha: prepared.targetSha,
    upstreamVersion: targetVersion,
    upstreamSchemaVersion: prepared.upstreamSchema,
  };
  const filename = path.join(prepared.candidateDir, MANIFEST);
  await fs.writeFile(filename, `${JSON.stringify(updated, null, 2)}\n`);
  git(prepared.candidateDir, "add", "--", MANIFEST);
  updated.customFiles = run(
    "git",
    ["diff", "--cached", "--name-only", "-z", prepared.targetSha, "--"],
    { cwd: prepared.candidateDir },
  )
    .stdout.split("\0")
    .filter(Boolean)
    .map(validateCustomPath)
    .sort();
  await fs.writeFile(filename, `${JSON.stringify(updated, null, 2)}\n`);
  git(prepared.candidateDir, "add", "--", MANIFEST);
}

async function verifyPreservation(candidateDir, manifest) {
  for (const relative of REQUIRED_FILES) {
    if (!(await fs.stat(path.join(candidateDir, relative))).isFile())
      throw new MaintenanceError(
        "error",
        `Required analytics feature file is missing: ${relative}`,
      );
  }
  const config = await jsonFile(
    path.join(candidateDir, "src-tauri/tauri.conf.json"),
  );
  if (
    config.identifier !== manifest.applicationIdentifier ||
    config.identifier !== "com.ccswitch.desktop"
  )
    throw new MaintenanceError(
      "error",
      "Candidate application identifier would change account/data ownership",
    );
  const schema = schemaVersion(
    await fs.readFile(
      path.join(candidateDir, "src-tauri/src/database/mod.rs"),
      "utf8",
    ),
  );
  if (schema !== manifest.customSchemaVersion)
    throw new MaintenanceError(
      "migration_review",
      "Customization schema was not preserved",
    );
  const registration = await fs.readFile(
    path.join(candidateDir, "src-tauri/src/lib.rs"),
    "utf8",
  );
  const usagePage = await fs.readFile(
    path.join(candidateDir, "src/components/usage/UsagePage.tsx"),
    "utf8",
  );
  if (
    !registration.includes("commands::unified_usage_sync") ||
    !usagePage.includes("UnifiedUsageDashboard")
  )
    throw new MaintenanceError(
      "error",
      "Candidate lost analytics command or navigation registration",
    );
  const localBuild = await jsonFile(
    path.join(candidateDir, "scripts/unified-usage-local-build.json"),
  );
  if (localBuild.bundle?.createUpdaterArtifacts !== false)
    throw new MaintenanceError(
      "error",
      "Unsigned custom build must disable official updater artifacts",
    );
  await verifyUpdaterCapabilities(candidateDir);
}

export async function verifyAndBuild(prepared, output, build) {
  const nativeTarget = {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
    ia32: "i686-pc-windows-msvc",
  }[process.arch];
  const env = {
    ...process.env,
    CC_SWITCH_TEST_HOME: path.join(output, "test-home"),
    CODEX_HOME: path.join(output, "test-codex-home"),
    CARGO_TARGET_DIR: path.join(prepared.candidateDir, "src-tauri/target"),
    CARGO_BUILD_TARGET: nativeTarget,
    CARGO_BUILD_JOBS: "2",
  };
  for (const name of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CHATGPT_TOKEN",
    "CODEX_AUTH_TOKEN",
    "NODE_OPTIONS",
    "NODE_PATH",
    "TAURI_CONFIG",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ])
    delete env[name];
  await fs.mkdir(env.CC_SWITCH_TEST_HOME, { recursive: true });
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  const steps = [
    [
      "maintenance fixture tests",
      process.execPath,
      ["--test", "tests/maintenance/maintain-upstream.test.mjs"],
    ],
    ["dependencies", "corepack", ["pnpm", "install", "--frozen-lockfile"]],
    ["types", "corepack", ["pnpm", "typecheck"]],
    ["frontend tests", "corepack", ["pnpm", "test:unit"]],
    ["renderer", "corepack", ["pnpm", "build:renderer"]],
    [
      "analytics Rust tests",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "tests/unified-usage-core/Cargo.toml",
      ],
    ],
    [
      "native Rust check",
      "cargo",
      ["check", "--locked", "--manifest-path", "src-tauri/Cargo.toml"],
    ],
    [
      "native analytics Rust tests",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "unified_usage",
        "--lib",
      ],
    ],
    [
      "native updater policy tests",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "unified_updates",
        "--lib",
      ],
    ],
    [
      "native Google OAuth configuration test",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "services::subscription::tests::gemini_oauth_client_configuration_requires_a_complete_explicit_pair",
        "--lib",
        "--",
        "--exact",
      ],
    ],
    [
      "native v25 migration test",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "migration_v24_to_v25",
        "--lib",
      ],
    ],
    [
      "native v26 migration test",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "migration_v25_to_v26",
        "--lib",
      ],
    ],
  ];
  if (build) {
    if (process.platform !== "win32" || !nativeTarget)
      throw new MaintenanceError(
        "error",
        "Native candidate builds currently require Windows with MSVC and Windows SDK",
      );
    steps.push([
      "nativeBuild",
      "corepack",
      [
        "pnpm",
        "tauri",
        "build",
        "--no-bundle",
        "--target",
        nativeTarget,
        "-c",
        "scripts/unified-usage-local-build.json",
      ],
    ]);
  }
  const checks = [];
  for (const [name, program, args] of steps) {
    console.log(`Checking ${name}`);
    try {
      run(program, args, { cwd: prepared.candidateDir, env });
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({ name, passed: false });
      error.checks = checks;
      throw error;
    }
  }
  return checks;
}

async function packageWindows(prepared, output, targetVersion) {
  const packageDir = path.join(output, "windows-package");
  await fs.mkdir(packageDir);
  const nativeTarget = {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
    ia32: "i686-pc-windows-msvc",
  }[process.arch];
  await fs.copyFile(
    path.join(
      prepared.candidateDir,
      "src-tauri/target",
      nativeTarget,
      "release/cc-switch.exe",
    ),
    path.join(packageDir, "cc-switch.exe"),
  );
  // Use the loader from the dependency actually selected by this build. Never
  // collect DLLs from a user's application-data or authentication directories.
  const architecture = { x64: "x64", arm64: "arm64", ia32: "x86" }[
    process.arch
  ];
  const buildLoaders = [
    path.join(
      prepared.candidateDir,
      "src-tauri/target",
      nativeTarget,
      "release/WebView2Loader.dll",
    ),
    path.join(
      prepared.candidateDir,
      "src-tauri/target/release/WebView2Loader.dll",
    ),
  ];
  let loader;
  for (const candidate of buildLoaders)
    if (
      await fs
        .stat(candidate)
        .then((stat) => stat.isFile())
        .catch(() => false)
    ) {
      loader = candidate;
      break;
    }
  if (!loader) {
    const metadata = JSON.parse(
      run(
        "cargo",
        [
          "metadata",
          "--locked",
          "--format-version",
          "1",
          "--manifest-path",
          "src-tauri/Cargo.toml",
        ],
        { cwd: prepared.candidateDir },
      ).stdout,
    );
    const webviews = metadata.packages.filter(
      (entry) => entry.name === "webview2-com-sys",
    );
    if (webviews.length !== 1 || !architecture)
      throw new MaintenanceError(
        "error",
        "Cannot identify one matching WebView2 loader dependency",
      );
    loader = path.join(
      path.dirname(webviews[0].manifest_path),
      architecture,
      "WebView2Loader.dll",
    );
  }
  await fs.copyFile(loader, path.join(packageDir, "WebView2Loader.dll"));
  await fs.copyFile(
    path.join(prepared.candidateDir, "LICENSE"),
    path.join(packageDir, "LICENSE.txt"),
  );
  await fs.writeFile(
    path.join(packageDir, "README.txt"),
    `CC Switch Unified Usage ${targetVersion}\r\n\r\nClose CC Switch before replacing program files. Keep cc-switch.exe and WebView2Loader.dll together. Microsoft Edge WebView2 Runtime is required. This unsigned custom build is not an official upstream release. Account data and OS credentials are not included; this build retains the existing application identifier and local database location. See the source archive docs/unified-updates.md for migration and update limitations.\r\n`,
  );
  const archive = path.join(
    output,
    `CC-Switch-Unified-Usage-${targetVersion}-Windows-${process.arch}.zip`,
  );
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const members = [
    "cc-switch.exe",
    "WebView2Loader.dll",
    "LICENSE.txt",
    "README.txt",
  ]
    .map((name) => quote(path.join(packageDir, name)))
    .join(",");
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  run(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -LiteralPath @(${members}) -DestinationPath ${quote(archive)} -ErrorAction Stop`,
    ],
    { cwd: prepared.candidateDir },
  );
  return { archive, executable: path.join(packageDir, "cc-switch.exe") };
}

export async function runMaintenance(options, dependencies = {}) {
  const { sourceRoot, output, targetVersion, build = false } = options;
  let result = {
    phase: "error",
    built: false,
    targetVersion: targetVersion ?? null,
    candidateDir: null,
    error: null,
    checks: [],
  };
  let safeToReport = false;
  try {
    await assertOutputBoundary(sourceRoot, output);
    await fs.mkdir(output, { recursive: true });
    const stat = await fs.lstat(output);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.readdir(output)).length !== 0
    )
      throw new MaintenanceError(
        "error",
        "Update output must be a new, empty, nonsymlink job directory",
      );
    safeToReport = true;
    if (!VERSION.test(targetVersion ?? ""))
      throw new MaintenanceError(
        "error",
        "Target version must be a stable x.y.z release",
      );
    if (!build)
      throw new MaintenanceError(
        "error",
        "Production update candidates require --build; merge-only preparation is not a ready application",
      );
    const manifest = await jsonFile(path.join(sourceRoot, MANIFEST));
    if (
      manifest.edition !== "cc-switch-unified-usage" ||
      manifest.upstreamRepository !== OFFICIAL_REPOSITORY
    )
      throw new MaintenanceError(
        "error",
        "Unrecognized customization provenance",
      );
    if (!isNewerVersion(targetVersion, manifest.upstreamVersion))
      throw new MaintenanceError(
        "error",
        "Target must be newer than the pinned upstream baseline",
      );
    const release = await (
      dependencies.resolveRelease ?? resolveOfficialRelease
    )(targetVersion);
    const prepared = await prepareSource({
      sourceRoot,
      output,
      manifest,
      targetVersion,
      targetRef: release.tag,
      repository: dependencies.repository ?? OFFICIAL_REPOSITORY,
    });
    result.candidateDir = prepared.candidateDir;
    await verifyPreservation(prepared.candidateDir, manifest);
    await advanceCandidateManifest(prepared, manifest, targetVersion);
    result.checks = await verifyAndBuild(prepared, output, build);
    if (git(prepared.candidateDir, "diff", "--name-only"))
      throw new MaintenanceError(
        "error",
        "Build changed tracked source after validation; review generated changes before packaging",
      );
    const windowsPackage = await packageWindows(
      prepared,
      output,
      targetVersion,
    );
    const tree = git(prepared.candidateDir, "write-tree");
    const archive = path.join(
      output,
      `CC-Switch-Unified-Usage-${targetVersion}-source.zip`,
    );
    git(
      prepared.candidateDir,
      "archive",
      "--format=zip",
      "--prefix=cc-switch-unified-usage/",
      `--output=${archive}`,
      tree,
    );
    result = {
      ...result,
      phase: "ready",
      built: true,
      nativeBuild: {
        passed: true,
        platform: "windows",
        architecture: process.arch,
      },
      upstreamSha: prepared.targetSha,
      sourceArchive: archive,
      binaryArchive: windowsPackage.archive,
      executable: windowsPackage.executable,
      error: null,
    };
  } catch (error) {
    result.phase = error.phase ?? "error";
    result.error = error.message;
    if (error.checks) result.checks = error.checks;
    if (!result.candidateDir) {
      const possible = path.join(output, "candidate");
      if (
        await fs
          .stat(possible)
          .then((stat) => stat.isDirectory())
          .catch(() => false)
      )
        result.candidateDir = possible;
    }
  }
  if (safeToReport)
    await fs.writeFile(
      path.join(output, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    sourceRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    build: false,
  };
  try {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--build") options.build = true;
      else if (
        ["--target-version", "--output"].includes(args[index]) &&
        args[index + 1] &&
        !args[index + 1].startsWith("--")
      ) {
        options[args[index] === "--output" ? "output" : "targetVersion"] =
          args[++index];
      } else
        throw new MaintenanceError(
          "error",
          "Usage: node scripts/maintain-upstream.mjs --target-version x.y.z --output <new-job-directory> [--build]",
        );
    }
    if (!options.output)
      throw new MaintenanceError(
        "error",
        "An isolated output directory is required",
      );
    options.output = path.resolve(options.output);
    const result = await runMaintenance(options);
    console.log(JSON.stringify(result));
    process.exitCode = result.phase === "ready" ? 0 : 1;
  } catch (error) {
    if (options.output) {
      // Parse errors must not turn an unsafe --output into a write to the
      // original source tree or overwrite an earlier attempt's result.
      try {
        await assertOutputBoundary(
          options.sourceRoot,
          path.resolve(options.output),
        );
        await fs.mkdir(options.output, { recursive: true });
        if ((await fs.readdir(options.output)).length === 0)
          await fs.writeFile(
            path.join(options.output, "result.json"),
            `${JSON.stringify({ phase: "error", built: false, targetVersion: options.targetVersion ?? null, candidateDir: null, error: error.message }, null, 2)}\n`,
          );
      } catch {
        /* Unsafe/unwritable destinations get stderr only. */
      }
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
