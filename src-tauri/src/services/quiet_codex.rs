//! Quiet Windows Codex commands must launch the installed native executable.
//! The official npm launcher spawns it without `windowsHide`, so hiding only
//! cmd.exe/Node does not prevent a visible grandchild console.
use serde_json::Value;
use std::fs::{self, File};
#[cfg(windows)]
use std::io;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const METADATA_LIMIT: u64 = 64 * 1024;
const OFFICIAL_REPOSITORY: &str = "git+https://github.com/openai/codex.git";

#[derive(Clone, Copy)]
struct WindowsTarget {
    package: &'static str,
    triple: &'static str,
    suffix: &'static str,
    machine: u16,
}

fn host_target() -> Option<WindowsTarget> {
    match std::env::consts::ARCH {
        "x86_64" => Some(WindowsTarget {
            package: "@openai/codex-win32-x64",
            triple: "x86_64-pc-windows-msvc",
            suffix: "win32-x64",
            machine: 0x8664,
        }),
        "aarch64" => Some(WindowsTarget {
            package: "@openai/codex-win32-arm64",
            triple: "aarch64-pc-windows-msvc",
            suffix: "win32-arm64",
            machine: 0xaa64,
        }),
        _ => None,
    }
}

fn bounded_read(path: &Path) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(METADATA_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= METADATA_LIMIT).then_some(bytes)
}

fn package_json(root: &Path) -> Option<Value> {
    serde_json::from_slice(&bounded_read(&root.join("package.json"))?).ok()
}

fn official_repository(package: &Value) -> bool {
    package
        .pointer("/repository/url")
        .or_else(|| package.get("repository"))
        .and_then(Value::as_str)
        .is_some_and(|value| {
            value == OFFICIAL_REPOSITORY || value == "https://github.com/openai/codex.git"
        })
}

/// Only the generated npm shim is bypassed. A custom wrapper may supply flags
/// or environment settings and must not silently be interpreted as that shim.
fn standard_npm_shim(path: &Path) -> bool {
    let Some(bytes) = bounded_read(path) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return false;
    };
    let text = text.replace('\\', "/").to_ascii_lowercase();
    let lines = text
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let expected = "endlocal & goto #_undefined_# 2>nul || title %comspec% & \"%_prog%\" \"%dp0%/node_modules/@openai/codex/bin/codex.js\" %*";
    let allowed = [
        "@echo off",
        "goto start",
        ":find_dp0",
        "set dp0=%~dp0",
        "exit /b",
        ":start",
        "setlocal",
        "call :find_dp0",
        "if exist \"%dp0%/node.exe\" (",
        "set \"_prog=%dp0%/node.exe\"",
        ") else (",
        "set \"_prog=node\"",
        "set pathext=%pathext:;.js;=;%",
        ")",
        expected,
    ];
    lines.first().is_some_and(|line| line == "@echo off")
        && lines.last().is_some_and(|line| line == expected)
        && lines.iter().all(|line| allowed.contains(&line.as_str()))
}

fn matching_pe(path: &Path, machine: u16) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut dos = [0u8; 64];
    if file.read_exact(&mut dos).is_err() || &dos[..2] != b"MZ" {
        return false;
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap());
    if !(64..=1024 * 1024).contains(&offset) || file.seek(SeekFrom::Start(offset as u64)).is_err() {
        return false;
    }
    let mut header = [0u8; 6];
    file.read_exact(&mut header).is_ok()
        && &header[..4] == b"PE\0\0"
        && u16::from_le_bytes([header[4], header[5]]) == machine
}

fn contained_native(root: &Path, target: WindowsTarget) -> Option<PathBuf> {
    let root = fs::canonicalize(root).ok()?;
    let binary = fs::canonicalize(
        root.join("vendor")
            .join(target.triple)
            .join("bin/codex.exe"),
    )
    .ok()?;
    (binary.starts_with(&root) && matching_pe(&binary, target.machine)).then_some(binary)
}

pub fn is_codex_entry(path: &Path) -> bool {
    path.file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("codex"))
}

#[derive(Debug)]
pub struct NativeCodex {
    pub executable: PathBuf,
    pub package_root: Option<PathBuf>,
}

/// Mirrors this selected npm installation's platform-package resolution; never
/// substitutes another Codex found elsewhere on PATH. Metadata is not a digital
/// signature: the selected installation already has the user's local trust.
pub fn resolve_native_codex(entry: &Path) -> Option<NativeCodex> {
    let target = host_target()?;
    if !is_codex_entry(entry) {
        return None;
    }
    if entry
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return matching_pe(entry, target.machine).then(|| NativeCodex {
            executable: entry.to_path_buf(),
            package_root: None,
        });
    }
    if !entry
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd"))
        || !standard_npm_shim(entry)
    {
        return None;
    }
    let root = fs::canonicalize(entry.parent()?.join("node_modules/@openai/codex")).ok()?;
    let package = package_json(&root)?;
    let version = package.get("version")?.as_str()?;
    semver::Version::parse(version).ok()?;
    if package.get("name")?.as_str()? != "@openai/codex"
        || !official_repository(&package)
        || package.pointer("/bin/codex").and_then(Value::as_str) != Some("bin/codex.js")
    {
        return None;
    }
    let launcher = fs::canonicalize(root.join("bin/codex.js")).ok()?;
    if !launcher.starts_with(&root) {
        return None;
    }
    let declared = package
        .get("optionalDependencies")
        .and_then(|deps| deps.get(target.package))
        .and_then(Value::as_str);
    let executable = if let Some(declared) = declared {
        let aliased_version = format!("{version}-{}", target.suffix);
        let alias = format!("npm:@openai/codex@{aliased_version}");
        let (expected_name, expected_version) = if declared == alias {
            ("@openai/codex", aliased_version.as_str())
        } else if declared == version {
            (target.package, version)
        } else {
            return None;
        };
        // Node searches node_modules from the package upward. The first present
        // platform package is authoritative, even if it is incomplete/mismatched.
        let mut found = None;
        for ancestor in root.ancestors().take(16) {
            let candidate = ancestor.join("node_modules").join(target.package);
            if candidate.join("package.json").is_file() {
                found = Some(candidate);
                break;
            }
        }
        let platform = found?;
        let metadata = package_json(&platform)?;
        if metadata.get("name").and_then(Value::as_str) != Some(expected_name)
            || metadata.get("version").and_then(Value::as_str) != Some(expected_version)
            || !official_repository(&metadata)
        {
            return None;
        }
        contained_native(&platform, target)?
    } else {
        // Older official releases bundled vendor directly in the main package.
        contained_native(&root, target)?
    };
    Some(NativeCodex {
        executable,
        package_root: Some(root),
    })
}

#[cfg(windows)]
pub fn native_command(
    entry: &Path,
    args: &[&str],
    search_path: &str,
) -> io::Result<std::process::Command> {
    use std::os::windows::process::CommandExt;
    let resolved=resolve_native_codex(entry).ok_or_else(||io::Error::new(io::ErrorKind::NotFound,
        "Quiet Codex commands require the matching native Windows executable. Reinstall the current official Codex CLI; custom script launchers are not started in the background."))?;
    let mut command = std::process::Command::new(resolved.executable);
    command
        .args(args)
        .env("PATH", search_path)
        .creation_flags(0x08000000);
    if let Some(root) = resolved.package_root {
        command.env("CODEX_MANAGED_PACKAGE_ROOT", root);
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SHIM:&str="@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\nIF EXIST \"%dp0%\\node.exe\" (\nSET \"_prog=%dp0%\\node.exe\"\n) ELSE (\nSET \"_prog=node\"\nSET PATHEXT=%PATHEXT:;.JS;=;%\n)\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\n";

    fn metadata(root: &Path, value: Value) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("package.json"), value.to_string()).unwrap();
    }
    fn pe(path: &Path, machine: u16) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut bytes = vec![0u8; 256];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&128u32.to_le_bytes());
        bytes[128..132].copy_from_slice(b"PE\0\0");
        bytes[132..134].copy_from_slice(&machine.to_le_bytes());
        fs::write(path, bytes).unwrap();
    }
    fn fixture(root: &Path, optional: bool) -> (PathBuf, PathBuf, PathBuf) {
        let target = host_target().unwrap();
        let entry = root.join("codex.cmd");
        fs::write(&entry, SHIM).unwrap();
        let package = root.join("node_modules/@openai/codex");
        let mut main = json!({"name":"@openai/codex","version":"0.166.0","repository":{"url":OFFICIAL_REPOSITORY},"bin":{"codex":"bin/codex.js"}});
        if optional {
            main["optionalDependencies"] =
                json!({(target.package):format!("npm:@openai/codex@0.166.0-{}",target.suffix)});
        }
        metadata(&package, main);
        fs::create_dir_all(package.join("bin")).unwrap();
        fs::write(package.join("bin/codex.js"), "// official launcher fixture").unwrap();
        let platform = if optional {
            let platform = package.join("node_modules").join(target.package);
            metadata(
                &platform,
                json!({"name":"@openai/codex","version":format!("0.166.0-{}",target.suffix),"repository":{"url":OFFICIAL_REPOSITORY}}),
            );
            platform
        } else {
            package
        };
        let executable = platform
            .join("vendor")
            .join(target.triple)
            .join("bin/codex.exe");
        pe(&executable, target.machine);
        (entry, platform, executable)
    }

    #[test]
    fn selected_npm_installation_resolves_matching_native_without_running_the_shim() {
        let temp = tempfile::tempdir().unwrap();
        let (entry, _, binary) = fixture(temp.path(), true);
        let resolved = resolve_native_codex(&entry).unwrap();
        assert_eq!(resolved.executable, fs::canonicalize(binary).unwrap());
        assert!(resolved
            .package_root
            .unwrap()
            .ends_with("node_modules/@openai/codex"));
    }
    #[test]
    fn mismatched_package_version_architecture_and_custom_shims_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let (entry, platform, binary) = fixture(temp.path(), true);
        let mut value = package_json(&platform).unwrap();
        value["version"] = json!("0.165.0-win32-x64");
        metadata(&platform, value);
        assert!(resolve_native_codex(&entry).is_none());
        let (entry, _, binary2) = fixture(temp.path(), true);
        assert_eq!(binary, binary2);
        pe(
            &binary,
            if host_target().unwrap().machine == 0x8664 {
                0xaa64
            } else {
                0x8664
            },
        );
        assert!(resolve_native_codex(&entry).is_none());
        fixture(temp.path(), true);
        fs::write(&entry, SHIM.replace(" %*", " --custom-profile %*")).unwrap();
        assert!(resolve_native_codex(&entry).is_none());
    }
    #[test]
    fn legacy_bundled_vendor_and_sibling_optional_package_are_supported() {
        let legacy = tempfile::tempdir().unwrap();
        let (entry, _, binary) = fixture(legacy.path(), false);
        assert_eq!(
            resolve_native_codex(&entry).unwrap().executable,
            fs::canonicalize(binary).unwrap()
        );
        let modern = tempfile::tempdir().unwrap();
        let (entry, platform, binary) = fixture(modern.path(), true);
        let relative = binary.strip_prefix(&platform).unwrap();
        let sibling = modern
            .path()
            .join("node_modules")
            .join(host_target().unwrap().package);
        fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        fs::rename(&platform, &sibling).unwrap();
        assert_eq!(
            resolve_native_codex(&entry).unwrap().executable,
            fs::canonicalize(sibling.join(relative)).unwrap()
        );
    }
    #[test]
    fn incomplete_optional_package_never_falls_back_to_an_unrelated_native() {
        let temp = tempfile::tempdir().unwrap();
        let (entry, _, binary) = fixture(temp.path(), true);
        fs::remove_file(binary).unwrap();
        let target = host_target().unwrap();
        let legacy = temp
            .path()
            .join("node_modules/@openai/codex/vendor")
            .join(target.triple)
            .join("bin/codex.exe");
        pe(&legacy, target.machine);
        assert!(resolve_native_codex(&entry).is_none());
    }

    #[test]
    fn selected_standalone_native_is_supported_without_npm_or_path_substitution() {
        let temporary = tempfile::tempdir().unwrap();
        let binary = temporary.path().join("codex.exe");
        pe(&binary, host_target().unwrap().machine);
        let resolved = resolve_native_codex(&binary).unwrap();
        assert_eq!(resolved.executable, binary);
        assert!(resolved.package_root.is_none());
        fs::write(&resolved.executable, "not a native executable").unwrap();
        assert!(resolve_native_codex(&resolved.executable).is_none());
    }
    #[cfg(unix)]
    #[test]
    fn vendor_symlink_cannot_escape_its_verified_platform_package() {
        let temp = tempfile::tempdir().unwrap();
        let (entry, _, binary) = fixture(temp.path(), true);
        fs::remove_file(&binary).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let other = outside.path().join("codex.exe");
        pe(&other, host_target().unwrap().machine);
        std::os::unix::fs::symlink(other, binary).unwrap();
        assert!(resolve_native_codex(&entry).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn unverified_script_cannot_start_a_background_shell() {
        let temporary = tempfile::tempdir().unwrap();
        let entry = temporary.path().join("codex.cmd");
        let marker = temporary.path().join("unwanted-shell.txt");
        fs::write(
            &entry,
            format!("@echo off\r\necho launched>\"{}\"\r\n", marker.display()),
        )
        .unwrap();
        let result = native_command(&entry, &["app-server"], "");
        assert!(result.is_err());
        assert!(!marker.exists());
    }

    #[cfg(windows)]
    #[test]
    fn quiet_child_reports_console_state() {
        let Some(report) = std::env::var_os("CC_SWITCH_QUIET_CHILD_REPORT") else {
            return;
        };
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        // SAFETY: this reads this isolated test process's console handle only.
        let absent = unsafe { GetConsoleWindow().is_null() };
        fs::write(report, if absent { "no_console" } else { "has_console" }).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn resolved_native_helper_actually_runs_without_a_console() {
        let temp = tempfile::tempdir().unwrap();
        let (entry, _, binary) = fixture(temp.path(), true);
        let own_exe = std::env::current_exe().unwrap();
        fs::copy(&own_exe, binary).unwrap();
        let report = temp.path().join("console-state.txt");
        let name = module_path!().split_once("::").unwrap().1;
        let child_test = format!("{name}::quiet_child_reports_console_state");
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        let search_path = format!(
            "{};{};{}",
            own_exe.parent().unwrap().display(),
            std::env::current_dir().unwrap().display(),
            inherited.to_string_lossy()
        );
        let mut command = native_command(
            &entry,
            &["--exact", &child_test, "--nocapture"],
            &search_path,
        )
        .unwrap();
        command
            .env_clear()
            .env("PATH", &search_path)
            .env(
                "SystemRoot",
                std::env::var_os("SystemRoot").unwrap_or_default(),
            )
            .env("CC_SWITCH_QUIET_CHILD_REPORT", &report)
            .current_dir(temp.path());
        let output = command.output().unwrap();
        assert!(output.status.success(), "isolated helper failed");
        assert_eq!(fs::read_to_string(report).unwrap(), "no_console");
    }
}
