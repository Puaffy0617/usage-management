import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  channelConfig,
  configureReleaseChannel,
  validatePublicKey,
  validateRepository,
  validateCustomVersion,
} from "../../scripts/configure-release-channel.mjs";

const publicBytes = Buffer.alloc(42, 1);
publicBytes.write("Ed", 0);
const publicKey = Buffer.from(
  `untrusted comment: minisign public key: 0101010101010101\n${publicBytes.toString("base64")}\n`,
).toString("base64");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cc-switch-channel-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const folder of ["customization", "src-tauri"])
    await fs.mkdir(path.join(root, folder));
  const files = {
    "customization/release-channel.json": JSON.stringify({ enabled: false }),
    "customization/upstream.json": JSON.stringify({
      edition: "cc-switch-unified-usage",
      upstreamVersion: "4.0.25",
      applicationIdentifier: "com.ccswitch.desktop",
    }),
    "package.json": JSON.stringify({ name: "cc-switch", version: "4.0.25" }),
    "src-tauri/tauri.conf.json": JSON.stringify({
      identifier: "com.ccswitch.desktop",
      version: "4.0.25",
      plugins: {
        updater: {
          pubkey: "upstream-key",
          endpoints: ["https://official.example/latest.json"],
        },
      },
    }),
    "src-tauri/Cargo.toml":
      '[package]\nname = "cc-switch"\nversion = "4.0.25"\n\n[dependencies]\nother = "1"\n',
    "src-tauri/Cargo.lock":
      'version = 4\n\n[[package]]\nname = "cc-switch"\nversion = "4.0.25"\ndependencies = ["other"]\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n',
  };
  for (const [name, data] of Object.entries(files))
    await fs.writeFile(path.join(root, name), data);
  return { root, files };
}

test("custom channel validates exact repository, dedicated key and custom revision", () => {
  const config = channelConfig(
    "User/usage-management",
    publicKey,
    "4.0.25-usage.1",
  );
  assert.equal(config.enabled, true);
  assert.equal(config.channel, "stable");
  for (const invalid of [
    "https://github.com/User/repo",
    "User/repo/extra",
    "User/../repo",
    "farion1231/cc-switch",
  ])
    assert.throws(() => validateRepository(invalid));
  for (const invalid of [
    "4.0.25",
    "4.0.25+usage.1",
    "4.0.25-usage.0",
    "4.0.25-usage.01",
    "4.0.25-beta.1",
  ])
    assert.throws(() => validateCustomVersion(invalid));
  for (const invalid of [
    "secret key",
    Buffer.from(
      "untrusted comment: minisign encrypted secret key\nanything",
    ).toString("base64"),
    "AAAA",
  ])
    assert.throws(() => validatePublicKey(invalid));
});

test("preview does not modify source files", async (t) => {
  const { root, files } = await fixture(t);
  const result = await configureReleaseChannel(root, {
    repository: "User/usage-management",
    publicKey,
  });
  assert.equal(result.written, false);
  assert.equal(result.version, "4.0.25-usage.1");
  for (const [name, content] of Object.entries(files))
    assert.equal(await fs.readFile(path.join(root, name), "utf8"), content);
});

test("bootstrap aligns package, native and pin versions without changing identity or official detector", async (t) => {
  const { root } = await fixture(t);
  await configureReleaseChannel(root, {
    repository: "User/usage-management",
    publicKey,
    version: "4.0.25-usage.2",
    write: true,
  });
  for (const relative of [
    "package.json",
    "src-tauri/tauri.conf.json",
    "customization/release-channel.json",
  ]) {
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, relative), "utf8")).version,
      "4.0.25-usage.2",
    );
  }
  const tauri = JSON.parse(
    await fs.readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(tauri.identifier, "com.ccswitch.desktop");
  assert.equal(tauri.plugins.updater.pubkey, "upstream-key");
  assert.deepEqual(tauri.plugins.updater.endpoints, [
    "https://official.example/latest.json",
  ]);
  assert.match(
    await fs.readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8"),
    /version = "4\.0\.25-usage\.2"/,
  );
  assert.match(
    await fs.readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8"),
    /name = "cc-switch"\nversion = "4\.0\.25-usage\.2"/,
  );
  assert.match(
    await fs.readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8"),
    /name = "other"\nversion = "1\.0\.0"/,
  );
});

test("bootstrap refuses the upstream verification key and leaves all files intact", async (t) => {
  const { root } = await fixture(t);
  const tauriPath = path.join(root, "src-tauri/tauri.conf.json");
  const tauri = JSON.parse(await fs.readFile(tauriPath, "utf8"));
  tauri.plugins.updater.pubkey = publicKey;
  await fs.writeFile(tauriPath, JSON.stringify(tauri));
  await assert.rejects(
    configureReleaseChannel(root, {
      repository: "User/usage-management",
      publicKey,
      write: true,
    }),
    /upstream key/,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
      .version,
    "4.0.25",
  );
});

test("bootstrap rejects an application identity change before any write", async (t) => {
  const { root } = await fixture(t);
  const tauriPath = path.join(root, "src-tauri/tauri.conf.json");
  const tauri = JSON.parse(await fs.readFile(tauriPath, "utf8"));
  tauri.identifier = "unrelated.app";
  await fs.writeFile(tauriPath, JSON.stringify(tauri));
  await assert.rejects(
    configureReleaseChannel(root, {
      repository: "User/usage-management",
      publicKey,
      write: true,
    }),
    /identity/,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(root, "customization/release-channel.json"),
        "utf8",
      ),
    ).enabled,
    false,
  );
});
