import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  OFFICIAL_REPOSITORY,
  prepareSource,
  runMaintenance,
  validateCustomPath,
  isNewerVersion,
  verifyUpdaterCapabilities,
  advanceCandidateManifest,
} from "../../scripts/maintain-upstream.mjs";

function git(cwd, ...args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  });
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Maintenance Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { cwd, env, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function write(root, relative, content) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

async function fixture(t, { conflict = false, schema = 24 } = {}) {
  const temporaryParent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(
    path.join(temporaryParent, "cc-switch-maintenance-test-"),
  );
  t.after(async () => {
    const resolved = await fs.realpath(root);
    // Verify the exact generated test boundary before recursive cleanup.
    assert.equal(path.dirname(resolved), temporaryParent);
    assert.ok(
      path.basename(resolved).startsWith("cc-switch-maintenance-test-"),
    );
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const repository = path.join(root, "official-fixture");
  const sourceRoot = path.join(root, "source-archive");
  const output = path.join(root, "job");
  await fs.mkdir(repository);
  await fs.mkdir(sourceRoot);
  await fs.mkdir(output);
  git(repository, "init", "--quiet");
  const original = [
    "header",
    "local slot: old",
    ...Array.from({ length: 12 }, (_, index) => `unchanged line ${index}`),
    "upstream slot: old",
    "footer",
    "",
  ].join("\n");
  await write(repository, "feature.txt", original);
  await write(repository, "package.json", '{"version":"1.0.0"}\n');
  await write(
    repository,
    "src-tauri/src/database/mod.rs",
    "pub(crate) const SCHEMA_VERSION: i32 = 24;\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "baseline");
  const baseline = git(repository, "rev-parse", "HEAD");
  await write(
    repository,
    "feature.txt",
    original.replace(
      conflict ? "local slot: old" : "upstream slot: old",
      conflict ? "local slot: upstream" : "upstream slot: new",
    ),
  );
  await write(repository, "package.json", '{"version":"1.1.0"}\n');
  await write(
    repository,
    "src-tauri/src/database/mod.rs",
    `pub(crate) const SCHEMA_VERSION: i32 = ${schema};\n`,
  );
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "official update");
  git(repository, "tag", "v1.1.0");
  const manifest = {
    edition: "cc-switch-unified-usage",
    upstreamRepository: OFFICIAL_REPOSITORY,
    upstreamSha: baseline,
    upstreamVersion: "1.0.0",
    upstreamSchemaVersion: 24,
    customSchemaVersion: 26,
    applicationIdentifier: "com.ccswitch.desktop",
    customFiles: ["feature.txt", "customization/upstream.json"],
  };
  await write(
    sourceRoot,
    "feature.txt",
    original.replace("local slot: old", "local slot: custom"),
  );
  await write(
    sourceRoot,
    "customization/upstream.json",
    JSON.stringify(manifest),
  );
  // Synthetic private-data sentinels are deliberately outside the allowlist.
  await write(
    sourceRoot,
    ".cc-switch/private.db",
    "DO_NOT_PACKAGE_PRIVATE_FIXTURE",
  );
  await write(sourceRoot, "auth.json", "DO_NOT_PACKAGE_AUTH_FIXTURE");
  return {
    sourceRoot,
    output,
    manifest,
    repository,
    targetVersion: "1.1.0",
    targetRef: "v1.1.0",
  };
}

test("source archive without .git merges independent upstream and custom changes", async (t) => {
  const options = await fixture(t);
  const before = await fs.readFile(
    path.join(options.sourceRoot, "feature.txt"),
    "utf8",
  );
  assert.equal(
    await fs.stat(path.join(options.sourceRoot, ".git")).catch(() => null),
    null,
  );
  const prepared = await prepareSource(options);
  const merged = await fs.readFile(
    path.join(prepared.candidateDir, "feature.txt"),
    "utf8",
  );
  assert.match(merged, /local slot: custom/);
  assert.match(merged, /upstream slot: new/);
  assert.equal(
    await fs.readFile(path.join(options.sourceRoot, "feature.txt"), "utf8"),
    before,
  );
  const tracked = git(prepared.candidateDir, "ls-files");
  assert.doesNotMatch(tracked, /private\.db|auth\.json/);
  assert.equal(
    await fs
      .stat(path.join(prepared.candidateDir, "auth.json"))
      .catch(() => null),
    null,
  );
});

test("overlapping changes stop with a conflict report and no application artifact", async (t) => {
  const options = await fixture(t, { conflict: true });
  const result = await runMaintenance(
    { ...options, build: true },
    {
      repository: options.repository,
      resolveRelease: async () => ({ tag: "v1.1.0" }),
    },
  );
  assert.equal(result.phase, "conflict");
  assert.equal(result.built, false);
  assert.ok(result.candidateDir);
  assert.match(
    git(result.candidateDir, "diff", "--name-only", "--diff-filter=U"),
    /feature\.txt/,
  );
  assert.equal(
    (await fs.readdir(options.output)).some((name) =>
      /\.(?:exe|zip)$/i.test(name),
    ),
    false,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(options.output, "result.json"), "utf8"),
    ).phase,
    "conflict",
  );
});

test("upstream migration changes are gated before customization application", async (t) => {
  const options = await fixture(t, { schema: 25, conflict: true });
  const result = await runMaintenance(
    { ...options, build: true },
    {
      repository: options.repository,
      resolveRelease: async () => ({ tag: "v1.1.0" }),
    },
  );
  assert.equal(result.phase, "migration_review");
  assert.equal(result.built, false);
  assert.equal(result.candidateDir, null);
  assert.equal(
    await fs
      .stat(path.join(options.output, "customization.patch"))
      .catch(() => null),
    null,
  );
  assert.match(result.error, /schema is 25/);
});

test("private-data and traversal paths are rejected before a source overlay", async (t) => {
  for (const bad of [
    "../auth.json",
    ".cc-switch/private.db",
    "auth.json",
    "src/.env",
    "src/cache.sqlite",
    "src/link/../../secret",
    "/absolute/file",
    "src\\escape",
  ])
    assert.throws(() => validateCustomPath(bad));
  const options = await fixture(t);
  options.manifest.customFiles.push("../auth.json");
  await assert.rejects(prepareSource(options), /unsafe or private-data path/);
  assert.equal(
    await fs.stat(path.join(options.output, "candidate")).catch(() => null),
    null,
  );
});

test("an obsolete customization deletion does not fail Git pathspec staging", async (t) => {
  const options = await fixture(t);
  options.manifest.customFiles.push("removed-custom-file.txt");
  const prepared = await prepareSource(options);
  const merged = await fs.readFile(
    path.join(prepared.candidateDir, "feature.txt"),
    "utf8",
  );
  assert.match(merged, /local slot: custom/);
  assert.match(merged, /upstream slot: new/);
  await advanceCandidateManifest(
    prepared,
    options.manifest,
    options.targetVersion,
  );
  const candidateManifest = JSON.parse(
    await fs.readFile(
      path.join(prepared.candidateDir, "customization/upstream.json"),
      "utf8",
    ),
  );
  assert.equal(candidateManifest.upstreamVersion, "1.1.0");
  assert.equal(candidateManifest.upstreamSha, prepared.targetSha);
  assert.equal(
    candidateManifest.customFiles.includes("removed-custom-file.txt"),
    false,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(options.sourceRoot, "customization/upstream.json"),
        "utf8",
      ),
    ).upstreamVersion,
    "1.0.0",
  );
});

test("nonempty update directories are refused without changing existing files", async (t) => {
  const options = await fixture(t);
  await write(options.output, "keep.txt", "existing contents");
  await assert.rejects(prepareSource(options), /new, empty, nonsymlink/);
  assert.equal(
    await fs.readFile(path.join(options.output, "keep.txt"), "utf8"),
    "existing contents",
  );
  assert.deepEqual(await fs.readdir(options.output), ["keep.txt"]);
});

test("unsafe output containment never modifies the original source or result", async (t) => {
  const options = await fixture(t);
  await write(options.sourceRoot, "result.json", "ORIGINAL_SOURCE_RESULT");
  for (const output of [
    options.sourceRoot,
    path.join(options.sourceRoot, "future-job"),
    path.dirname(options.sourceRoot),
  ]) {
    const result = await runMaintenance({ ...options, output, build: true });
    assert.equal(result.phase, "error");
    assert.match(result.error, /separate directories/);
  }
  assert.equal(
    await fs.readFile(path.join(options.sourceRoot, "result.json"), "utf8"),
    "ORIGINAL_SOURCE_RESULT",
  );
  assert.equal(
    await fs
      .stat(path.join(options.sourceRoot, "future-job"))
      .catch(() => null),
    null,
  );
  // The CLI's parse-error reporting must enforce the same boundary.
  const script = fileURLToPath(
    new URL("../../scripts/maintain-upstream.mjs", import.meta.url),
  );
  await write(
    options.sourceRoot,
    "scripts/maintain-upstream.mjs",
    await fs.readFile(script),
  );
  const child = spawnSync(
    process.execPath,
    [
      path.join(options.sourceRoot, "scripts/maintain-upstream.mjs"),
      "--output",
      options.sourceRoot,
      "--invalid",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 1);
  assert.equal(
    await fs.readFile(path.join(options.sourceRoot, "result.json"), "utf8"),
    "ORIGINAL_SOURCE_RESULT",
  );
});

test("candidate capabilities allow checks and refuse stock install/download permissions", async (t) => {
  const options = await fixture(t);
  await write(
    options.sourceRoot,
    "src-tauri/capabilities/default.json",
    JSON.stringify({ permissions: ["core:default", "updater:allow-check"] }),
  );
  await verifyUpdaterCapabilities(options.sourceRoot);
  for (const permission of [
    "updater:default",
    "updater:allow-install",
    "updater:allow-download",
    "updater:allow-download-and-install",
    "updater:*",
  ]) {
    await write(
      options.sourceRoot,
      "src-tauri/capabilities/tray.json",
      JSON.stringify({ permissions: [{ identifier: permission }] }),
    );
    await assert.rejects(
      verifyUpdaterCapabilities(options.sourceRoot),
      /only updater:allow-check/,
    );
  }
});

test("an unbuilt source preparation cannot report a ready application", async (t) => {
  const options = await fixture(t);
  const result = await runMaintenance(
    { ...options, build: false },
    {
      resolveRelease: () => {
        throw new Error("Must not reach the network");
      },
    },
  );
  assert.equal(result.phase, "error");
  assert.equal(result.built, false);
  assert.match(result.error, /require --build/);
});

test("stable version comparison rejects option-like targets, equality and downgrades", () => {
  assert.equal(isNewerVersion("4.0.26", "4.0.25"), true);
  assert.equal(isNewerVersion("4.0.25", "4.0.25"), false);
  assert.equal(isNewerVersion("4.0.24", "4.0.25"), false);
  assert.equal(isNewerVersion("--upload-pack=bad", "4.0.25"), false);
  assert.equal(isNewerVersion("4.0.26-beta.1", "4.0.25"), false);
});

test("CLI argument failures still emit a machine-readable failure result", async (t) => {
  const options = await fixture(t);
  const script = fileURLToPath(
    new URL("../../scripts/maintain-upstream.mjs", import.meta.url),
  );
  const processResult = spawnSync(
    process.execPath,
    [script, "--output", options.output, "--target-version", "--invalid"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(processResult.status, 1);
  const result = JSON.parse(
    await fs.readFile(path.join(options.output, "result.json"), "utf8"),
  );
  assert.equal(result.phase, "error");
  assert.equal(result.built, false);
});
