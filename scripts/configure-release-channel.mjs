import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EDITION = "cc-switch-unified-usage";
export function validateRepository(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(
      value,
    )
  ) {
    throw new Error("Use the exact GitHub owner/repository name");
  }
  if (value.toLowerCase() === "farion1231/cc-switch")
    throw new Error(
      "The official upstream repository is not a custom release destination",
    );
  return value;
}

export function validateCustomVersion(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-usage\.([1-9]\d*)$/.test(value)
  ) {
    throw new Error("Use a custom version such as 4.0.25-usage.1");
  }
  if (
    value
      .split(/[.-]/)
      .some((part) => /^\d+$/.test(part) && !Number.isSafeInteger(Number(part)))
  )
    throw new Error("Version component is too large");
  return value;
}

export function validatePublicKey(raw) {
  const key = String(raw).trim();
  if (key.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key))
    throw new Error(
      "Expected a Tauri base64 public key file, not a private key",
    );
  const bytes = Buffer.from(key, "base64");
  if (bytes.toString("base64") !== key)
    throw new Error("Public key encoding is invalid");
  const lines = bytes.toString("utf8").trim().split(/\r?\n/);
  if (
    lines.length !== 2 ||
    !lines[0].startsWith("untrusted comment: minisign public key:")
  )
    throw new Error("Expected a minisign public key");
  const binary = Buffer.from(lines[1], "base64");
  if (
    binary.length !== 42 ||
    !["Ed", "ED"].includes(binary.subarray(0, 2).toString("ascii"))
  )
    throw new Error("Invalid minisign public key bytes");
  return key;
}

export function channelConfig(repository, publicKey, version) {
  return {
    edition: EDITION,
    enabled: true,
    repository: validateRepository(repository),
    publicKey: validatePublicKey(publicKey),
    channel: "stable",
    version: validateCustomVersion(version),
  };
}

export async function configureReleaseChannel(root, options) {
  const resolved = await fs.realpath(root);
  const inputs = [
    "customization/release-channel.json",
    "customization/upstream.json",
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ];
  const originals = new Map();
  for (const relative of inputs) {
    const full = path.join(resolved, relative);
    const info = await fs.lstat(full);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Refusing nonregular source file: ${relative}`);
    originals.set(relative, await fs.readFile(full, "utf8"));
  }
  const upstream = JSON.parse(originals.get("customization/upstream.json"));
  if (upstream.edition !== EDITION)
    throw new Error("This source is not the unified usage edition");
  const config = channelConfig(
    options.repository,
    options.publicKey,
    options.version ?? `${upstream.upstreamVersion}-usage.1`,
  );
  const tauri = JSON.parse(originals.get("src-tauri/tauri.conf.json"));
  if (
    tauri.identifier !== upstream.applicationIdentifier ||
    tauri.identifier !== "com.ccswitch.desktop"
  )
    throw new Error("Application identity must stay unchanged");
  if (config.publicKey === tauri.plugins?.updater?.pubkey)
    throw new Error(
      "Generate a new custom signing key; do not reuse the upstream key",
    );
  const pkg = JSON.parse(originals.get("package.json"));
  pkg.version = config.version;
  tauri.version = config.version;
  // Keep the stock endpoint for advisory checks only. Native custom installation
  // derives its endpoint and verification key exclusively from the pinned file.
  const cargo = originals.get("src-tauri/Cargo.toml");
  const packageBlock = cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/);
  if (!packageBlock || !/^name\s*=\s*"cc-switch"\s*$/m.test(packageBlock[1]))
    throw new Error("Cannot find application Cargo package");
  const nextBlock = packageBlock[0].replace(
    /^version\s*=\s*"[^"]+"\s*$/m,
    `version = "${config.version}"`,
  );
  if (
    nextBlock === packageBlock[0] &&
    !packageBlock[0].includes(`version = "${config.version}"`)
  )
    throw new Error("Cannot find Cargo package version");
  const lock = originals.get("src-tauri/Cargo.lock");
  const lockExpression =
    /(\[\[package\]\]\s*\r?\nname = "cc-switch"\s*\r?\nversion = ")[^"]+("[\s\S]*?)(?=\r?\n\[\[package\]\]|$)/;
  if (!lockExpression.test(lock))
    throw new Error("Cannot find application lockfile entry");
  const json = (value) => JSON.stringify(value, null, 2) + "\n";
  const changes = new Map([
    ["customization/release-channel.json", json(config)],
    ["package.json", json(pkg)],
    ["src-tauri/tauri.conf.json", json(tauri)],
    ["src-tauri/Cargo.toml", cargo.replace(packageBlock[0], nextBlock)],
    [
      "src-tauri/Cargo.lock",
      lock.replace(
        lockExpression,
        (_, prefix, suffix) => prefix + config.version + suffix,
      ),
    ],
  ]);
  if (options.write) {
    const written = [];
    try {
      for (const [relative, contents] of changes) {
        const full = path.join(resolved, relative);
        const temp = full + `.channel-${process.pid}.tmp`;
        try {
          await fs.writeFile(temp, contents, { flag: "wx" });
          await fs.rename(temp, full);
        } finally {
          await fs.rm(temp, { force: true });
        }
        written.push(relative);
      }
    } catch (error) {
      for (const relative of written)
        await fs.writeFile(
          path.join(resolved, relative),
          originals.get(relative),
        );
      throw error;
    }
  }
  return {
    repository: config.repository,
    version: config.version,
    endpoint: `https://github.com/${config.repository}/releases/latest/download/latest.json`,
    files: [...changes.keys()],
    written: Boolean(options.write),
  };
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--write") options.write = true;
    else if (
      ["--repository", "--public-key-file", "--version"].includes(key) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      options[key] = args[++i];
    else
      throw new Error(
        "Usage: node scripts/configure-release-channel.mjs --repository owner/repo --public-key-file path.pub [--version 4.0.25-usage.1] [--write]",
      );
  }
  if (!options["--public-key-file"])
    throw new Error("A public key file is required; never pass a private key");
  const keyPath = options["--public-key-file"];
  if ((await fs.stat(keyPath)).size > 8192)
    throw new Error("Public key file is too large");
  const publicKey = await fs.readFile(keyPath, "utf8");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(
    JSON.stringify(
      await configureReleaseChannel(root, {
        repository: options["--repository"],
        publicKey,
        version: options["--version"],
        write: options.write,
      }),
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
