import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";

export const EDITION = "cc-switch-unified-usage";
export const PIN_FILE = "customization/release-channel.json";
const SIGNING_FAILURE =
  "Trusted installer signing failed; verify the protected key/password";

export function commandFailure(
  program,
  args,
  result,
  { env = {}, signing = false } = {},
) {
  if (signing) return SIGNING_FAILURE;
  const redact = (value) => {
    let text = String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const secrets = Object.entries(env)
      .filter(
        ([name, secret]) =>
          /PRIVATE_KEY|PASSWORD|TOKEN|SECRET|API_KEY|GOOGLE_OAUTH_CLIENT_ID/i.test(
            name,
          ) &&
          typeof secret === "string" &&
          secret.length >= 4,
      )
      .map(([, secret]) => secret)
      .sort((left, right) => right.length - left.length);
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  };
  const status = result.status ?? result.signal ?? "unavailable";
  return `${program} ${args[0] ?? ""} failed (exit ${status}). ${redact(result.error?.message)}\n[stdout summary]\n${redact(result.stdout).slice(-8000)}\n[stderr tail]\n${redact(result.stderr).slice(-12000)}`;
}
export const CUSTOM_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-usage\.([1-9]\d*)$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const STOCK_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM4MDI4QzlBNTczOTI4RTMKUldUaktEbFhtb3dDeUM5US9kT0FmdGR5Ti9vQzcwa2dTMlpibDVDUmQ2M0VGTzVOWnd0SGpFVlEK";

export function assertCustomVersion(version) {
  if (typeof version !== "string" || !CUSTOM_VERSION.test(version))
    throw new Error(
      "Expected custom version x.y.z-usage.N with a positive revision",
    );
  return version;
}

export function isNewerCustomVersion(target, current) {
  const left = assertCustomVersion(target)
      .match(CUSTOM_VERSION)
      .slice(1)
      .map(BigInt),
    right = assertCustomVersion(current)
      .match(CUSTOM_VERSION)
      .slice(1)
      .map(BigInt);
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}

export function decodeBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("Invalid base64 signing data");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, ""))
    throw new Error("Noncanonical signing data");
  return bytes;
}

export function publicKeyRecord(publicKey) {
  const lines = decodeBase64(publicKey.trim())
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: "))
    throw new Error("Invalid Tauri public-key envelope");
  const record = decodeBase64(lines[1]);
  if (
    record.length !== 42 ||
    record.subarray(0, 2).toString() !== "Ed" ||
    record.subarray(10).every((byte) => byte === 0)
  )
    throw new Error("Invalid Minisign public key");
  return record;
}

export function validatePin(pin) {
  if (
    pin?.edition !== EDITION ||
    pin.enabled !== true ||
    pin.channel !== "stable"
  )
    throw new Error("Custom signed channel is not enabled");
  if (
    !REPOSITORY.test(pin.repository ?? "") ||
    pin.repository.toLowerCase() === "farion1231/cc-switch"
  )
    throw new Error("A distinct owner/repository must be pinned");
  assertCustomVersion(pin.version);
  if (typeof pin.publicKey !== "string" || pin.publicKey.trim() === STOCK_KEY)
    throw new Error("A distinct custom updater public key is required");
  publicKeyRecord(pin.publicKey);
  return pin;
}

export function expectedReleaseVersion(pin, upstreamVersion) {
  validatePin(pin);
  if (!upstreamVersion) return pin.version;
  if (!STABLE_VERSION.test(upstreamVersion))
    throw new Error("Invalid upstream version");
  const current = pin.version.split("-usage.")[0].split(".").map(BigInt),
    next = upstreamVersion.split(".").map(BigInt);
  let newer = false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== next[index]) {
      newer = next[index] > current[index];
      break;
    }
  }
  if (!newer)
    throw new Error(
      "Hosted upstream release must be newer than the pinned series",
    );
  return `${upstreamVersion}-usage.1`;
}

export function artifactName(version) {
  return `CC-Switch-Unified-Usage-${assertCustomVersion(version)}-windows-x86_64-setup.exe`;
}
export function artifactUrl(repository, version, fileName) {
  if (!REPOSITORY.test(repository) || fileName !== artifactName(version))
    throw new Error("Invalid pinned installer filename or repository");
  return `https://github.com/${repository}/releases/download/v${version}/${fileName}`;
}

export async function hashFile(filename) {
  const stat = await fs.lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > 1024 * 1024 * 1024
  )
    throw new Error("Invalid installer file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return { sha256: hash.digest("hex"), size: stat.size };
}

export async function readJson(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
    throw new Error("Invalid release metadata file");
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

export function verifyVersionedSignature(
  content,
  signature,
  publicKey,
  version,
) {
  assertCustomVersion(version);
  const publicRecord = publicKeyRecord(publicKey);
  const lines = decodeBase64(signature.trim())
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  )
    throw new Error("Invalid Minisign signature envelope");
  const record = decodeBase64(lines[1]),
    globalSignature = decodeBase64(lines[3]);
  if (
    record.length !== 74 ||
    globalSignature.length !== 64 ||
    !record.subarray(2, 10).equals(publicRecord.subarray(2, 10))
  )
    throw new Error("Signature key identity mismatch");
  const trusted = lines[2].slice("trusted comment: ".length);
  const versions = trusted
    .split("\t")
    .filter((field) => field.startsWith("version:"));
  if (versions.length !== 1 || versions[0] !== `version:${version}`)
    throw new Error("Signature does not bind the announced app version");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicRecord.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const algorithm = record.subarray(0, 2).toString();
  const message =
    algorithm === "ED"
      ? createHash("blake2b512").update(content).digest()
      : algorithm === "Ed"
        ? content
        : null;
  if (
    !message ||
    !verify(null, message, key, record.subarray(10)) ||
    !verify(
      null,
      Buffer.concat([record.subarray(10), Buffer.from(trusted)]),
      key,
      globalSignature,
    )
  )
    throw new Error("Updater signature verification failed");
  return true;
}

export async function validateBuildArtifact(
  directory,
  metadata,
  pin,
  { version = pin.version, sourceCommit } = {},
) {
  validatePin(pin);
  assertCustomVersion(version);
  if (
    metadata.format !== "cc-switch-hosted-release-v1" ||
    metadata.edition !== EDITION ||
    metadata.repository !== pin.repository ||
    metadata.channel !== pin.channel ||
    metadata.publicKey !== pin.publicKey ||
    metadata.version !== version ||
    metadata.platform !== "windows-x86_64"
  )
    throw new Error("Build artifact does not match pinned distribution");
  if (
    !/^[a-f0-9]{40}$/.test(metadata.sourceCommit ?? "") ||
    metadata.sourceCommit !== sourceCommit
  )
    throw new Error("Build source commit does not match the trusted workflow");
  const required = [
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
  ];
  if (
    !Array.isArray(metadata.checks) ||
    metadata.checks.some((check) => check.passed !== true) ||
    required.some(
      (name) =>
        !metadata.checks.some(
          (check) => check.name === name && check.passed === true,
        ),
    )
  )
    throw new Error("Required build checks are missing or failed");
  if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length !== 1)
    throw new Error("Expected one immutable Windows NSIS installer");
  const artifact = metadata.artifacts[0];
  if (artifact.kind !== "nsis" || artifact.fileName !== artifactName(version))
    throw new Error("Unexpected installer artifact path or type");
  const actual = await hashFile(path.join(directory, artifact.fileName));
  if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
    throw new Error("Installer changed after build validation");
  return artifact;
}

export function makeManifest(pin, version, signature, now = new Date()) {
  validatePin(pin);
  assertCustomVersion(version);
  if (typeof signature !== "string" || !signature.trim())
    throw new Error("Signed updater artifact is required");
  return {
    edition: EDITION,
    repository: pin.repository,
    channel: pin.channel,
    version,
    notes:
      "Custom CC Switch release with unified account analytics. See the source release for validation and limitations.",
    pub_date: now.toISOString(),
    platforms: {
      "windows-x86_64": {
        url: artifactUrl(pin.repository, version, artifactName(version)),
        signature: signature.trim(),
      },
    },
  };
}

export async function setProjectVersion(directory, version, updatePin = false) {
  if (!STABLE_VERSION.test(version) && !CUSTOM_VERSION.test(version))
    throw new Error("Invalid project version");
  for (const relative of ["package.json", "src-tauri/tauri.conf.json"]) {
    const filename = path.join(directory, relative),
      original = await fs.readFile(filename, "utf8");
    const updated = original.replace(
      /("version"\s*:\s*")[^"]+"/,
      (match, prefix) => `${prefix}${version}"`,
    );
    if (JSON.parse(updated).version !== version)
      throw new Error("Unsupported top-level JSON version layout");
    await fs.writeFile(filename, updated);
  }
  const cargoPath = path.join(directory, "src-tauri/Cargo.toml"),
    cargo = await fs.readFile(cargoPath, "utf8");
  const section = cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/);
  if (!section || !/\bversion\s*=\s*"[^"]+"/.test(section[1]))
    throw new Error("Unsupported Cargo package version layout");
  await fs.writeFile(
    cargoPath,
    cargo.replace(
      section[0],
      section[0].replace(
        /(\bversion\s*=\s*")[^"]+"/,
        (match, prefix) => `${prefix}${version}"`,
      ),
    ),
  );
  const lockPath = path.join(directory, "src-tauri/Cargo.lock"),
    lock = await fs.readFile(lockPath, "utf8");
  const packagePattern =
    /(\[\[package\]\]\r?\nname = "cc-switch"\r?\nversion = ")[^"]+"/;
  if (!packagePattern.test(lock))
    throw new Error("Unsupported Cargo lock package layout");
  await fs.writeFile(
    lockPath,
    lock.replace(packagePattern, (match, prefix) => `${prefix}${version}"`),
  );
  if (updatePin) {
    const pinPath = path.join(directory, PIN_FILE),
      pin = await readJson(pinPath);
    pin.version = version;
    await fs.writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
  }
}

export async function normalizeHostedOverlay(directory, upstreamVersion) {
  const pin = await readJson(path.join(directory, PIN_FILE)).catch((error) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (!pin?.enabled) return false;
  validatePin(pin);
  await setProjectVersion(directory, upstreamVersion);
  return true;
}

export async function advanceHostedCandidate(directory, upstreamVersion) {
  const pin = await readJson(path.join(directory, PIN_FILE)).catch((error) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (!pin?.enabled) return null;
  const version = expectedReleaseVersion(pin, upstreamVersion);
  await setProjectVersion(directory, version, true);
  return version;
}
