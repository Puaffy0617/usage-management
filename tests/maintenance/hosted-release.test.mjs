import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import YAML from "yaml";
import {
  prepareSource,
  advanceCandidateManifest,
} from "../../scripts/maintain-upstream.mjs";
import {
  validatePin,
  expectedReleaseVersion,
  artifactName,
  artifactUrl,
  hashFile,
  validateBuildArtifact,
  verifyVersionedSignature,
  makeManifest,
  setProjectVersion,
  normalizeHostedOverlay,
  advanceHostedCandidate,
  isNewerCustomVersion,
  commandFailure,
} from "../../scripts/hosted-release-lib.mjs";

const VERSION = "4.0.25-usage.1";
const COMMIT = "a".repeat(40);

test("command failures retain bounded test evidence while signing failures remain generic", () => {
  const secret = "fixture-sensitive-client-config";
  const result = {
    status: 1,
    stdout:
      "old output\n".repeat(1000) +
      "\u001b[31mTest Files 1 failed | 281 passed\u001b[0m",
    stderr:
      "old diagnostic\n".repeat(1200) + `${secret}\nIconPicker.test.tsx:109:34`,
    error: new Error(secret),
  };
  const diagnostic = commandFailure("corepack", ["pnpm"], result, {
    env: { CC_SWITCH_GOOGLE_OAUTH_CLIENT_SECRET: secret },
  });
  assert.match(diagnostic, /Test Files 1 failed \| 281 passed/);
  assert.match(diagnostic, /IconPicker\.test\.tsx:109:34/);
  assert.doesNotMatch(diagnostic, /fixture-sensitive-client-config|\u001b/);
  assert.ok(diagnostic.length < 21000);
  assert.equal(
    commandFailure("signer", [], result, { signing: true }),
    "Trusted installer signing failed; verify the protected key/password",
  );
});

function signingFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32),
    id = Buffer.from("0102030405060708", "hex");
  const publicRecord = Buffer.concat([Buffer.from("Ed"), id, publicBytes]);
  const pin = {
    edition: "cc-switch-unified-usage",
    enabled: true,
    repository: "fixture-owner/usage-management",
    publicKey: Buffer.from(
      `untrusted comment: fixture public key\n${publicRecord.toString("base64")}\n`,
    ).toString("base64"),
    channel: "stable",
    version: VERSION,
  };
  const signature = (content, version = VERSION, extra = "") => {
    const digest = createHash("blake2b512").update(content).digest(),
      detached = sign(null, digest, privateKey);
    const record = Buffer.concat([Buffer.from("ED"), id, detached]),
      trusted = `timestamp:1\tfile:fixture.exe\tversion:${version}${extra}`;
    const global = sign(
      null,
      Buffer.concat([detached, Buffer.from(trusted)]),
      privateKey,
    );
    return Buffer.from(
      `untrusted comment: fixture signature\n${record.toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`,
    ).toString("base64");
  };
  return { pin, signature };
}
async function temporary(t) {
  const parent = await fs.realpath(os.tmpdir()),
    root = await fs.mkdtemp(path.join(parent, "cc-switch-hosted-test-"));
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.equal(path.dirname(real), parent);
    assert.ok(path.basename(real).startsWith("cc-switch-hosted-test-"));
    await fs.rm(real, { recursive: true, force: true });
  });
  return root;
}
async function write(root, relative, data) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, data);
}
const requiredChecks = [
  "types",
  "frontend tests",
  "renderer",
  "analytics Rust tests",
  "native Rust check",
  "native analytics Rust tests",
  "native updater policy tests",
  "native Google OAuth configuration test",
  "native v25 migration test",
  "native v26 migration test",
  "nativeBuild",
].map((name) => ({ name, passed: true }));

test("hosted pin requires a distinct enabled repository/key and custom revision", () => {
  const { pin } = signingFixture();
  assert.equal(validatePin(pin), pin);
  for (const changed of [
    { enabled: false },
    { repository: "farion1231/cc-switch" },
    { repository: "owner/repo/escape" },
    { publicKey: "invalid" },
    { version: "4.0.25+usage.1" },
    { channel: "beta" },
  ])
    assert.throws(() => validatePin({ ...pin, ...changed }));
  assert.equal(expectedReleaseVersion(pin, "4.0.26"), "4.0.26-usage.1");
  assert.throws(() => expectedReleaseVersion(pin, "4.0.25"));
  assert.throws(() => expectedReleaseVersion(pin, "--upload-pack=bad"));
  assert.equal(isNewerCustomVersion("4.0.25-usage.2", VERSION), true);
  assert.equal(isNewerCustomVersion(VERSION, VERSION), false);
  assert.equal(isNewerCustomVersion(VERSION, "4.0.26-usage.1"), false);
});

test("Minisign verification binds artifact bytes, key and exactly one signed version", () => {
  const { pin, signature } = signingFixture(),
    content = Buffer.from("immutable installer fixture");
  const signed = signature(content);
  assert.equal(
    verifyVersionedSignature(content, signed, pin.publicKey, VERSION),
    true,
  );
  assert.throws(
    () =>
      verifyVersionedSignature(
        Buffer.from("changed"),
        signed,
        pin.publicKey,
        VERSION,
      ),
    /verification failed/,
  );
  assert.throws(
    () =>
      verifyVersionedSignature(
        content,
        signed,
        pin.publicKey,
        "4.0.25-usage.2",
      ),
    /announced app version/,
  );
  assert.throws(
    () =>
      verifyVersionedSignature(
        content,
        signature(content, VERSION, `\tversion:${VERSION}`),
        pin.publicKey,
        VERSION,
      ),
    /announced app version/,
  );
  assert.throws(() =>
    verifyVersionedSignature(
      content,
      signed,
      signingFixture().pin.publicKey,
      VERSION,
    ),
  );
});

test("manifest markers and artifact URLs stay pinned to the custom stable release", () => {
  const { pin, signature } = signingFixture(),
    signed = signature(Buffer.from("fixture"));
  const manifest = makeManifest(
    pin,
    VERSION,
    signed,
    new Date("2026-11-05T00:00:00Z"),
  );
  assert.equal(manifest.edition, pin.edition);
  assert.equal(manifest.repository, pin.repository);
  assert.equal(manifest.channel, "stable");
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.platforms["windows-x86_64"].signature, signed);
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    `https://github.com/${pin.repository}/releases/download/v${VERSION}/${artifactName(VERSION)}`,
  );
  assert.throws(() => artifactUrl(pin.repository, VERSION, "../../private.db"));
});

test("artifact checks reject changes after a vetted build and missing validation", async (t) => {
  const root = await temporary(t),
    { pin } = signingFixture(),
    name = artifactName(VERSION);
  await write(root, name, "MZ immutable test installer");
  const metadata = {
    format: "cc-switch-hosted-release-v1",
    edition: pin.edition,
    repository: pin.repository,
    channel: pin.channel,
    publicKey: pin.publicKey,
    version: VERSION,
    sourceCommit: COMMIT,
    platform: "windows-x86_64",
    checks: requiredChecks,
    artifacts: [
      {
        kind: "nsis",
        fileName: name,
        ...(await hashFile(path.join(root, name))),
      },
    ],
  };
  await validateBuildArtifact(root, metadata, pin, { sourceCommit: COMMIT });
  await assert.rejects(
    validateBuildArtifact(
      root,
      { ...metadata, sourceCommit: "b".repeat(40) },
      pin,
      { sourceCommit: COMMIT },
    ),
    /trusted workflow/,
  );
  await assert.rejects(
    validateBuildArtifact(
      root,
      { ...metadata, checks: [{ name: "nativeBuild", passed: true }] },
      pin,
      { sourceCommit: COMMIT },
    ),
    /Required build checks/,
  );
  await write(root, name, "MZ modified test installer");
  await assert.rejects(
    validateBuildArtifact(root, metadata, pin, { sourceCommit: COMMIT }),
    /changed after build/,
  );
});

test("version normalization touches only own package fields and advances candidate pin", async (t) => {
  const root = await temporary(t),
    { pin } = signingFixture();
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "cc-switch",
      version: VERSION,
      dependencies: { untouched: "1.2.3" },
    }),
  );
  await write(
    root,
    "src-tauri/tauri.conf.json",
    JSON.stringify({ version: VERSION, identifier: "com.ccswitch.desktop" }),
  );
  await write(
    root,
    "src-tauri/Cargo.toml",
    `[package]\nname = "cc-switch"\nversion = "${VERSION}"\n[dependencies]\nother = { version = "2.0.0" }\n`,
  );
  await write(
    root,
    "src-tauri/Cargo.lock",
    `[[package]]\nname = "cc-switch"\nversion = "${VERSION}"\n\n[[package]]\nname = "other"\nversion = "2.0.0"\n`,
  );
  await write(root, "customization/release-channel.json", JSON.stringify(pin));
  assert.equal(await normalizeHostedOverlay(root, "4.0.25"), true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
      .version,
    "4.0.25",
  );
  assert.match(
    await fs.readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8"),
    /other = \{ version = "2.0.0" \}/,
  );
  assert.doesNotMatch(
    await fs.readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8"),
    /4\.0\.25""/,
  );
  assert.equal(await advanceHostedCandidate(root, "4.0.26"), "4.0.26-usage.1");
  for (const relative of [
    "package.json",
    "src-tauri/tauri.conf.json",
    "customization/release-channel.json",
  ])
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, relative), "utf8")).version,
      "4.0.26-usage.1",
    );
  assert.match(
    await fs.readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8"),
    /name = "cc-switch"\nversion = "4\.0\.26-usage\.1"/,
  );
  assert.match(
    await fs.readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8"),
    /name = "other"\nversion = "2\.0\.0"/,
  );
});

test("actual Tauri CLI version-bound signature is compatible with the verifier", async (t) => {
  const cli = fileURLToPath(
    new URL("../../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
  );
  if (!(await fs.stat(cli).catch(() => null))) {
    t.skip("Installed Tauri CLI required for compatibility fixture");
    return;
  }
  const root = await temporary(t),
    key = path.join(root, "ephemeral-fixture.key"),
    installer = path.join(root, "fixture.exe");
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/TAURI_SIGNING|PRIVATE_KEY|PASSWORD/.test(name)) delete env[name];
  let child = spawnSync(
    process.execPath,
    [cli, "signer", "generate", "--ci", "--password", "", "--write-keys", key],
    { env, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, "Ephemeral fixture key generation failed");
  await write(root, "fixture.exe", "MZ nonexecutable protocol fixture");
  env.TAURI_SIGNING_PRIVATE_KEY = (await fs.readFile(key, "utf8")).trim();
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  child = spawnSync(
    process.execPath,
    [cli, "signer", "sign", "--app-version", VERSION, installer],
    { env, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, "Ephemeral fixture signing failed");
  const signature = (await fs.readFile(`${installer}.sig`, "utf8")).trim(),
    publicKey = (await fs.readFile(`${key}.pub`, "utf8")).trim();
  assert.equal(
    verifyVersionedSignature(
      await fs.readFile(installer),
      signature,
      publicKey,
      VERSION,
    ),
    true,
  );
});

test("sign CLI fails without protected secret and never generates a production key", async (t) => {
  const root = await temporary(t),
    source = path.join(root, "trusted-source"),
    input = path.join(root, "unsigned"),
    { pin } = signingFixture();
  await fs.mkdir(input);
  for (const file of [
    "hosted-release.mjs",
    "hosted-release-lib.mjs",
    "maintain-upstream.mjs",
  ])
    await write(
      source,
      `scripts/${file}`,
      await fs.readFile(
        fileURLToPath(new URL(`../../scripts/${file}`, import.meta.url)),
      ),
    );
  await write(
    source,
    "customization/release-channel.json",
    JSON.stringify(pin),
  );
  const name = artifactName(VERSION),
    archive = `CC-Switch-Unified-Usage-${VERSION}-source.zip`;
  await write(input, name, "MZ installer fixture");
  await write(input, archive, "source archive fixture");
  await write(
    input,
    "build-metadata.json",
    JSON.stringify({
      format: "cc-switch-hosted-release-v1",
      edition: pin.edition,
      repository: pin.repository,
      channel: pin.channel,
      publicKey: pin.publicKey,
      version: VERSION,
      sourceCommit: COMMIT,
      platform: "windows-x86_64",
      checks: requiredChecks,
      artifacts: [
        {
          kind: "nsis",
          fileName: name,
          ...(await hashFile(path.join(input, name))),
        },
      ],
      sourceArchive: {
        fileName: archive,
        ...(await hashFile(path.join(input, archive))),
      },
    }),
  );
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: pin.repository,
    GITHUB_SHA: COMMIT,
  };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  const child = spawnSync(
    process.execPath,
    [
      path.join(source, "scripts/hosted-release.mjs"),
      "sign",
      "--input",
      input,
      "--output",
      path.join(root, "signed"),
    ],
    { env, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 1);
  assert.match(
    child.stderr,
    /Protected TAURI_SIGNING_PRIVATE_KEY secret is required/,
  );
  assert.equal(
    await fs.stat(path.join(root, "signed")).catch(() => null),
    null,
  );
});

test("actual Git merge avoids custom/upstream version-line conflicts and regenerates the custom series", async (t) => {
  const root = await temporary(t),
    upstream = path.join(root, "upstream"),
    sourceRoot = path.join(root, "source"),
    output = path.join(root, "job");
  await fs.mkdir(upstream);
  await fs.mkdir(sourceRoot);
  await fs.mkdir(output);
  const git = (directory, ...args) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.toUpperCase().startsWith("GIT_"),
      ),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    });
    const child = spawnSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: directory, env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  };
  const files = {
    "package.json": '{"name":"cc-switch","version":"1.0.0"}\n',
    "src-tauri/tauri.conf.json":
      '{"version":"1.0.0","identifier":"com.ccswitch.desktop"}\n',
    "src-tauri/Cargo.toml":
      '[package]\nname = "cc-switch"\nversion = "1.0.0"\n',
    "src-tauri/Cargo.lock":
      '[[package]]\nname = "cc-switch"\nversion = "1.0.0"\n',
    "src-tauri/src/database/mod.rs":
      "pub(crate) const SCHEMA_VERSION: i32 = 24;\n",
    "feature.txt":
      "custom slot: old\n" +
      Array.from({ length: 12 }, (_, index) => `context ${index}\n`).join("") +
      "upstream slot: old\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await write(upstream, name, content);
    await write(sourceRoot, name, content);
  }
  git(upstream, "init", "--quiet");
  git(upstream, "add", ".");
  git(upstream, "commit", "--quiet", "-m", "baseline");
  const upstreamSha = git(upstream, "rev-parse", "HEAD");
  await setProjectVersion(upstream, "1.1.0");
  await write(
    upstream,
    "feature.txt",
    files["feature.txt"].replace("upstream slot: old", "upstream slot: new"),
  );
  git(upstream, "add", ".");
  git(upstream, "commit", "--quiet", "-m", "new version and feature");
  git(upstream, "tag", "v1.1.0");
  await setProjectVersion(sourceRoot, "1.0.0-usage.1");
  await write(
    sourceRoot,
    "feature.txt",
    files["feature.txt"].replace("custom slot: old", "custom slot: retained"),
  );
  await write(
    sourceRoot,
    "customization/release-channel.json",
    JSON.stringify({ ...signingFixture().pin, version: "1.0.0-usage.1" }),
  );
  const manifest = {
    upstreamSha,
    upstreamVersion: "1.0.0",
    upstreamSchemaVersion: 24,
    customSchemaVersion: 26,
    customFiles: [
      ...Object.keys(files).filter((name) => !name.endsWith("mod.rs")),
      "customization/release-channel.json",
      "customization/upstream.json",
    ],
  };
  await write(
    sourceRoot,
    "customization/upstream.json",
    JSON.stringify(manifest),
  );
  const prepared = await prepareSource({
    sourceRoot,
    output,
    manifest,
    targetVersion: "1.1.0",
    targetRef: "v1.1.0",
    repository: upstream,
  });
  await advanceCandidateManifest(prepared, manifest, "1.1.0");
  const packageJson = JSON.parse(
    await fs.readFile(path.join(prepared.candidateDir, "package.json"), "utf8"),
  );
  assert.equal(packageJson.version, "1.1.0-usage.1");
  const merged = await fs.readFile(
    path.join(prepared.candidateDir, "feature.txt"),
    "utf8",
  );
  assert.match(merged, /custom slot: retained/);
  assert.match(merged, /upstream slot: new/);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8"))
      .version,
    "1.0.0-usage.1",
  );
});

test("release workflows isolate signing credentials and pin repository/default branch", async () => {
  const workflow = YAML.parse(
    await fs.readFile(
      fileURLToPath(
        new URL(
          "../../.github/workflows/unified-hosted-release.yml",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  assert.equal(workflow.permissions.contents, "read");
  assert.match(workflow.jobs.build.if, /Puaffy0617\/usage-management/);
  assert.match(workflow.jobs.build.if, /default_branch/);
  assert.equal(
    JSON.stringify(workflow.jobs.build).includes("TAURI_SIGNING_PRIVATE_KEY"),
    false,
  );
  const signer = workflow.jobs["sign-and-publish"];
  assert.equal(signer.permissions.contents, "write");
  assert.match(signer.if, /Puaffy0617\/usage-management/);
  const secretSteps = signer.steps.filter(
    (step) => step.env?.TAURI_SIGNING_PRIVATE_KEY,
  );
  assert.equal(secretSteps.length, 1);
  assert.match(secretSteps[0].run, /hosted-release\.mjs sign/);
  assert.ok(
    signer.steps.some(
      (step) =>
        step.run?.includes("--ignore-scripts") &&
        step.run.includes("@tauri-apps/cli@2.12.4"),
    ),
  );
  assert.ok(signer.steps.some((step) => step.with?.["artifact-ids"]));
  const weekly = YAML.parse(
    await fs.readFile(
      fileURLToPath(
        new URL(
          "../../.github/workflows/unified-upstream.yml",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  assert.equal(weekly.jobs.hosted.permissions.contents, "write");
  assert.equal(
    weekly.jobs.hosted.uses,
    "./.github/workflows/unified-hosted-release.yml",
  );
  for (const name of [
    "CC_SWITCH_GOOGLE_OAUTH_CLIENT_ID",
    "CC_SWITCH_GOOGLE_OAUTH_CLIENT_SECRET",
  ]) {
    assert.equal(workflow.on.workflow_call.secrets[name].required, false);
    assert.equal(workflow.jobs.build.env[name], `\${{ secrets.${name} }}`);
    assert.equal(weekly.jobs.hosted.secrets[name], `\${{ secrets.${name} }}`);
    assert.equal(JSON.stringify(signer).includes(name), false);
  }
});
