#!/usr/bin/env node
// CI release producer. No key generation, application installation or user-data access.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyAndBuild } from "./maintain-upstream.mjs";
import {
  EDITION,
  PIN_FILE,
  validatePin,
  expectedReleaseVersion,
  artifactName,
  hashFile,
  readJson,
  validateBuildArtifact,
  makeManifest,
  verifyVersionedSignature,
  isNewerCustomVersion,
  commandFailure,
} from "./hosted-release-lib.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = "x86_64-pc-windows-msvc";
const TRUSTED_TAURI_CLI_VERSION = "2.12.4";

function run(
  program,
  args,
  { cwd = ROOT, env = process.env, signing = false, allowFailure = false } = {},
) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    shell: process.platform === "win32" && program === "corepack",
    encoding: "utf8",
    windowsHide: true,
    timeout: 90 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0))
    throw new Error(commandFailure(program, args, result, { env, signing }));
  return result;
}

async function emptyOutput(directory, source) {
  directory = path.resolve(directory);
  source = await fs.realpath(source);
  const contains = (left, right) => {
    const relative = path.relative(left, right);
    return (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };
  if (contains(directory, source) || contains(source, directory))
    throw new Error("Release output and source must be separate directories");
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory),
    real = await fs.realpath(directory);
  if (
    stat.isSymbolicLink() ||
    contains(real, source) ||
    contains(source, real) ||
    (await fs.readdir(directory)).length
  )
    throw new Error(
      "Release output must be a new empty directory outside source",
    );
  return real;
}

function cleanBuildEnvironment(output, source) {
  const env = {
    ...process.env,
    CARGO_BUILD_JOBS: "2",
    CARGO_BUILD_TARGET: TARGET,
    CARGO_TARGET_DIR: path.join(source, "src-tauri/target"),
    CC_SWITCH_TEST_HOME: path.join(output, "test-home"),
    CODEX_HOME: path.join(output, "test-codex-home"),
  };
  for (const name of Object.keys(env))
    if (
      /PRIVATE_KEY|PASSWORD|OPENAI_API_KEY|CODEX_API_KEY|CHATGPT_TOKEN|CODEX_AUTH_TOKEN|NODE_OPTIONS|NODE_PATH|TAURI_CONFIG/.test(
        name,
      )
    )
      delete env[name];
  return env;
}

async function projectVersion(source, expected) {
  const packageJson = await readJson(path.join(source, "package.json")),
    tauri = await readJson(path.join(source, "src-tauri/tauri.conf.json"));
  const cargo = await fs.readFile(
      path.join(source, "src-tauri/Cargo.toml"),
      "utf8",
    ),
    lock = await fs.readFile(path.join(source, "src-tauri/Cargo.lock"), "utf8");
  const cargoVersion = cargo.match(
    /\[package\][\s\S]*?\bversion\s*=\s*"([^"]+)"/,
  )?.[1];
  const lockVersion = lock.match(
    /\[\[package\]\]\r?\nname = "cc-switch"\r?\nversion = "([^"]+)"/,
  )?.[1];
  if (
    [packageJson.version, tauri.version, cargoVersion, lockVersion].some(
      (value) => value !== expected,
    ) ||
    tauri.identifier !== "com.ccswitch.desktop"
  )
    throw new Error(
      "Package, Cargo, lockfile, Tauri and pinned custom versions must match; application identifier must be preserved",
    );
  if (tauri.bundle?.windows?.allowDowngrades === false)
    throw new Error(
      "NSIS bootstrap must permit installing the pinned custom prerelease over the stock numeric version",
    );
}

async function build(options) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error(
      "Hosted release builds currently require Windows x64 with MSVC",
    );
  const source = await fs.realpath(options["source-dir"] ?? ROOT),
    pin = validatePin(await readJson(path.join(ROOT, PIN_FILE)));
  const version = expectedReleaseVersion(pin, options["upstream-version"]);
  const candidatePin = validatePin(await readJson(path.join(source, PIN_FILE)));
  if (
    candidatePin.repository !== pin.repository ||
    candidatePin.publicKey !== pin.publicKey ||
    candidatePin.channel !== pin.channel ||
    candidatePin.version !== version
  )
    throw new Error(
      "Candidate custom channel does not match the trusted repository/key/version",
    );
  if (
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_REPOSITORY !== pin.repository
  )
    throw new Error("Workflow repository is not the pinned distribution");
  const sourceCommit = options["source-commit"] ?? process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? ""))
    throw new Error("An immutable trusted source commit is required");
  await projectVersion(source, version);
  const output = await emptyOutput(options.output, source),
    env = cleanBuildEnvironment(output, source);
  await fs.mkdir(env.CC_SWITCH_TEST_HOME, { recursive: true });
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  let checks;
  if (options["validated-result"]) {
    const validated = await readJson(path.resolve(options["validated-result"]));
    if (
      validated.phase !== "ready" ||
      validated.built !== true ||
      validated.nativeBuild?.passed !== true ||
      (await fs.realpath(validated.candidateDir)) !== source ||
      !validated.checks?.length ||
      validated.checks.some((check) => check.passed !== true)
    )
      throw new Error("Upstream candidate was not fully built and validated");
    checks = [...validated.checks];
    run(
      process.execPath,
      ["--test", "tests/maintenance/hosted-release.test.mjs"],
      { cwd: source, env },
    );
    checks.push({ name: "hosted release tests", passed: true });
    run(
      "corepack",
      [
        "pnpm",
        "tauri",
        "bundle",
        "--bundles",
        "nsis",
        "--target",
        TARGET,
        "--config",
        "scripts/unified-usage-local-build.json",
        "--ci",
        "--no-sign",
      ],
      { cwd: source, env },
    );
  } else {
    checks = await verifyAndBuild({ candidateDir: source }, output, false);
    run(
      process.execPath,
      ["--test", "tests/maintenance/hosted-release.test.mjs"],
      { cwd: source, env },
    );
    checks.push({ name: "hosted release tests", passed: true });
    run(
      "corepack",
      [
        "pnpm",
        "tauri",
        "build",
        "--bundles",
        "nsis",
        "--target",
        TARGET,
        "--config",
        "scripts/unified-usage-local-build.json",
        "--ci",
        "--no-sign",
      ],
      { cwd: source, env },
    );
    checks.push({ name: "nativeBuild", passed: true });
  }
  const installers = path.join(
    source,
    "src-tauri/target",
    TARGET,
    "release/bundle/nsis",
  );
  const filenames = (await fs.readdir(installers)).filter(
    (name) => name.endsWith(".exe") && name.includes(version),
  );
  if (filenames.length !== 1)
    throw new Error("Expected exactly one installer for the custom version");
  const fileName = artifactName(version),
    destination = path.join(output, fileName);
  await fs.copyFile(path.join(installers, filenames[0]), destination);
  const bytes = await fs.readFile(destination);
  if (bytes.length < 65536 || bytes.subarray(0, 2).toString() !== "MZ")
    throw new Error("Build did not produce a Windows installer");
  const sourceTree = run("git", ["write-tree"], { cwd: source }).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceTree))
    throw new Error("Cannot identify immutable release source tree");
  if (run("git", ["diff", "--name-only"], { cwd: source }).stdout.trim())
    throw new Error("Build changed tracked source; review before releasing");
  const sourceArchive = `CC-Switch-Unified-Usage-${version}-source.zip`;
  run(
    "git",
    [
      "archive",
      "--format=zip",
      "--prefix=cc-switch-unified-usage/",
      `--output=${path.join(output, sourceArchive)}`,
      sourceTree,
    ],
    { cwd: source },
  );
  const upstream = await readJson(
    path.join(source, "customization/upstream.json"),
  );
  const metadata = {
    format: "cc-switch-hosted-release-v1",
    edition: EDITION,
    repository: pin.repository,
    channel: pin.channel,
    publicKey: pin.publicKey,
    version,
    sourceCommit,
    sourceTree,
    upstreamVersion: upstream.upstreamVersion,
    upstreamSha: upstream.upstreamSha,
    platform: "windows-x86_64",
    checks,
    artifacts: [{ kind: "nsis", fileName, ...(await hashFile(destination)) }],
    sourceArchive: {
      fileName: sourceArchive,
      ...(await hashFile(path.join(output, sourceArchive))),
    },
  };
  await fs.writeFile(
    path.join(output, "build-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  console.log(
    `Unsigned installer validated for ${version}; no signing key was used`,
  );
}

async function trustedInput(options) {
  const pin = validatePin(await readJson(path.join(ROOT, PIN_FILE))),
    version = expectedReleaseVersion(pin, options["upstream-version"]);
  if (process.env.GITHUB_REPOSITORY !== pin.repository)
    throw new Error("Signing/publication must run in the pinned repository");
  const sourceCommit = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? ""))
    throw new Error("Trusted workflow commit is required");
  const input = await fs.realpath(options.input),
    metadata = await readJson(path.join(input, "build-metadata.json"));
  const artifact = await validateBuildArtifact(input, metadata, pin, {
    version,
    sourceCommit,
  });
  const archive = metadata.sourceArchive;
  if (archive?.fileName !== `CC-Switch-Unified-Usage-${version}-source.zip`)
    throw new Error("Missing matching source archive");
  const actual = await hashFile(path.join(input, archive.fileName));
  if (actual.sha256 !== archive.sha256 || actual.size !== archive.size)
    throw new Error("Source archive changed after validation");
  return { pin, version, input, metadata, artifact };
}

async function sign(options) {
  const trusted = await trustedInput(options);
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
    throw new Error(
      "Protected TAURI_SIGNING_PRIVATE_KEY secret is required; no key is generated automatically",
    );
  const cli = await fs.realpath(options["tauri-cli"] ?? ""),
    cliPackage = await readJson(path.join(path.dirname(cli), "package.json"));
  if (
    cliPackage.name !== "@tauri-apps/cli" ||
    cliPackage.version !== TRUSTED_TAURI_CLI_VERSION
  )
    throw new Error(
      "Signing requires the pinned independently installed Tauri CLI",
    );
  if (cli.startsWith(`${trusted.input}${path.sep}`))
    throw new Error("Signing tools must not come from the candidate artifact");
  const output = await emptyOutput(options.output, ROOT),
    filename = path.join(output, trusted.artifact.fileName);
  await fs.copyFile(
    path.join(trusted.input, trusted.artifact.fileName),
    filename,
  );
  // Do not execute candidate code with signing credentials. CLI is installed by
  // the trusted workflow in a separate tool directory, with lifecycle scripts off.
  run(
    process.execPath,
    [cli, "signer", "sign", "--app-version", trusted.version, filename],
    { cwd: output, signing: true },
  );
  const signature = (await fs.readFile(`${filename}.sig`, "utf8")).trim();
  verifyVersionedSignature(
    await fs.readFile(filename),
    signature,
    trusted.pin.publicKey,
    trusted.version,
  );
  const manifest = makeManifest(trusted.pin, trusted.version, signature);
  await fs.copyFile(
    path.join(trusted.input, trusted.metadata.sourceArchive.fileName),
    path.join(output, trusted.metadata.sourceArchive.fileName),
  );
  await fs.writeFile(
    path.join(output, "build-metadata.json"),
    `${JSON.stringify(trusted.metadata, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(output, "latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const names = [
    trusted.artifact.fileName,
    `${trusted.artifact.fileName}.sig`,
    trusted.metadata.sourceArchive.fileName,
    "build-metadata.json",
    "latest.json",
  ];
  await fs.writeFile(
    path.join(output, "SHA256SUMS.txt"),
    (
      await Promise.all(
        names.map(
          async (name) =>
            `${(await hashFile(path.join(output, name))).sha256}  ${name}`,
        ),
      )
    ).join("\n") + "\n",
  );
  console.log(
    `Installer signature and signed app version verified for ${trusted.version}`,
  );
}

async function publish(options) {
  const trusted = await trustedInput(options),
    manifest = await readJson(path.join(trusted.input, "latest.json"));
  const signature = (
    await fs.readFile(
      path.join(trusted.input, `${trusted.artifact.fileName}.sig`),
      "utf8",
    )
  ).trim();
  verifyVersionedSignature(
    await fs.readFile(path.join(trusted.input, trusted.artifact.fileName)),
    signature,
    trusted.pin.publicKey,
    trusted.version,
  );
  const expected = makeManifest(
    trusted.pin,
    trusted.version,
    signature,
    new Date(manifest.pub_date),
  );
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error("Release manifest differs from the pinned signed artifact");
  if (!process.env.GH_TOKEN)
    throw new Error(
      "A workflow token with release contents:write permission is required",
    );
  const tag = `v${trusted.version}`,
    repository = trusted.pin.repository;
  const current = run(
    "gh",
    ["release", "view", "--repo", repository, "--json", "tagName"],
    { allowFailure: true },
  );
  if (
    current.status === 0 &&
    !isNewerCustomVersion(
      trusted.version,
      JSON.parse(current.stdout).tagName.replace(/^v/, ""),
    )
  )
    throw new Error("Publishing an equal or older custom version is refused");
  const existing = run(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "tagName"],
    { allowFailure: true },
  );
  if (existing.status === 0)
    throw new Error(
      "Release tag already exists; immutable signed releases are never overwritten",
    );
  const files = [
    trusted.artifact.fileName,
    `${trusted.artifact.fileName}.sig`,
    trusted.metadata.sourceArchive.fileName,
    "build-metadata.json",
    "latest.json",
    "SHA256SUMS.txt",
  ].map((name) => path.join(trusted.input, name));
  const notes = path.join(trusted.input, "release-notes.txt");
  await fs.writeFile(
    notes,
    `CC Switch Unified Usage ${trusted.version}\n\nBuilt and validated from ${trusted.metadata.sourceCommit}, source tree ${trusted.metadata.sourceTree}. Official upstream baseline: ${trusted.metadata.upstreamVersion}. Includes unified account analytics. Database migrations and unavailable-data limits are documented in the source archive. This is a custom release, not an official CC Switch binary.\n`,
  );
  run("gh", [
    "release",
    "create",
    tag,
    ...files,
    "--repo",
    repository,
    "--target",
    trusted.metadata.sourceCommit,
    "--title",
    `CC Switch Unified Usage ${trusted.version}`,
    "--notes-file",
    notes,
    "--draft",
  ]);
  // All assets are uploaded before the release can become the stable endpoint.
  const remote = JSON.parse(
    run("gh", [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "assets",
    ]).stdout,
  );
  if (
    files.some(
      (filename) =>
        !remote.assets.some((asset) => asset.name === path.basename(filename)),
    )
  )
    throw new Error(
      "Draft release is missing required assets; it remains unpublished",
    );
  run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    "--prerelease=false",
    "--latest",
  ]);
  console.log(`Published custom stable release ${tag}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2),
    options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (
      ![
        "--source-dir",
        "--output",
        "--input",
        "--validated-result",
        "--upstream-version",
        "--source-commit",
        "--tauri-cli",
      ].includes(args[index]) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error("Invalid hosted release arguments");
    options[args[index].slice(2)] = args[index + 1];
  }
  if (command === "build") await build(options);
  else if (command === "sign") await sign(options);
  else if (command === "publish") await publish(options);
  else throw new Error("Expected build, sign or publish command");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
