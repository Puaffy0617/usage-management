//! Official per-thread lifetime snapshots. Local rollout headers supply candidate
//! IDs only; neither the current login nor creation metadata assigns ownership.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_GROUPS: usize = 2048;
const MAX_HEADER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsageGroup {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub speed: Option<String>,
    pub estimated_usage_credits_micros: u64,
    pub net_new_input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsageSnapshot {
    pub thread_id: String,
    /// No usage date is supplied by the server. This is always None.
    pub day: Option<String>,
    pub estimated_usage_credits_micros: u64,
    pub estimated_usage_usd_micros: Option<u64>,
    pub native_usage_usd_micros: Option<u64>,
    pub groups: Vec<ThreadUsageGroup>,
}

pub fn canonical_thread_id(value: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| "Invalid canonical thread identifier".to_string())
}

fn count(value: Option<&Value>, required: bool) -> Result<Option<u64>, String> {
    match value {
        None | Some(Value::Null) if !required => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(Some)
            .ok_or_else(|| "Thread usage has an invalid or unsafe integer".into()),
        None => Err("Thread usage is missing a required counter".into()),
    }
}

fn label(value: Option<&Value>, maximum: usize) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if !value.trim().is_empty()
                && value.len() <= maximum
                && !value.chars().any(char::is_control) =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err("Thread usage has an invalid group label".into()),
    }
}

/// Parses the official RPC result, not a raw HTTP response. Missing/null
/// threadUsage is unavailable, never zero. No credit-to-dollar conversion occurs.
pub fn parse_thread_usage(
    expected_thread_id: &str,
    response: &Value,
) -> Result<Option<ThreadUsageSnapshot>, String> {
    let expected = canonical_thread_id(expected_thread_id)?;
    let response = response.as_object().ok_or("Invalid thread usage result")?;
    let Some(value) = response.get("threadUsage").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let object = value.as_object().ok_or("Invalid thread usage snapshot")?;
    let thread_id = canonical_thread_id(
        object
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or("Thread usage has no identifier")?,
    )?;
    if thread_id != expected {
        return Err("Thread usage returned a different thread".into());
    }
    let raw_groups = object
        .get("groups")
        .and_then(Value::as_array)
        .filter(|groups| groups.len() <= MAX_GROUPS)
        .ok_or("Thread usage has invalid or excessive model groups")?;
    let mut groups = Vec::with_capacity(raw_groups.len());
    let mut seen = HashSet::new();
    for raw in raw_groups {
        let group = raw.as_object().ok_or("Invalid thread usage model group")?;
        let model = label(group.get("model"), 256)?;
        let reasoning_effort = label(group.get("reasoningEffort"), 64)?;
        let speed = label(group.get("speed"), 64)?;
        if !seen.insert((model.clone(), reasoning_effort.clone(), speed.clone())) {
            return Err("Thread usage returned duplicate model groups".into());
        }
        let parsed = ThreadUsageGroup {
            model,
            reasoning_effort,
            speed,
            estimated_usage_credits_micros: count(group.get("estimatedUsageCreditsMicros"), true)?
                .unwrap(),
            net_new_input_tokens: count(group.get("netNewInputTokens"), false)?,
            cached_input_tokens: count(group.get("cachedInputTokens"), false)?,
            input_tokens: count(group.get("inputTokens"), false)?,
            output_tokens: count(group.get("outputTokens"), false)?,
            total_tokens: count(group.get("totalTokens"), false)?,
        };
        if let (Some(input), Some(cached)) = (parsed.input_tokens, parsed.cached_input_tokens) {
            if cached > input {
                return Err("Thread usage has inconsistent cached input".into());
            }
        }
        if let (Some(input), Some(output), Some(total)) = (
            parsed.input_tokens,
            parsed.output_tokens,
            parsed.total_tokens,
        ) {
            if input.checked_add(output) != Some(total) {
                return Err("Thread usage has inconsistent token totals".into());
            }
        }
        groups.push(parsed);
    }
    groups.sort_by(|left, right| {
        (&left.model, &left.reasoning_effort, &left.speed).cmp(&(
            &right.model,
            &right.reasoning_effort,
            &right.speed,
        ))
    });
    Ok(Some(ThreadUsageSnapshot {
        thread_id,
        day: None,
        estimated_usage_credits_micros: count(object.get("estimatedUsageCreditsMicros"), true)?
            .unwrap(),
        estimated_usage_usd_micros: count(object.get("estimatedUsageUsdMicros"), false)?,
        native_usage_usd_micros: count(object.get("nativeUsageUsdMicros"), false)?,
        groups,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCandidate {
    pub thread_id: String,
    pub modified_at_ms: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct DiscoveryLimits {
    pub max_files: usize,
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_header_bytes: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            max_files: 4000,
            max_entries: 20_000,
            max_depth: 5,
            max_header_bytes: MAX_HEADER_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCandidateDiscovery {
    pub candidates: Vec<ThreadCandidate>,
    pub scanned_files: usize,
    pub ignored_files: usize,
    pub truncated: bool,
}

#[derive(Deserialize)]
struct RolloutHeader {
    #[serde(rename = "type")]
    kind: String,
    payload: RolloutHeaderId,
}

#[derive(Deserialize)]
struct RolloutHeaderId {
    id: String,
}

/// Reads only the first bounded JSONL record. All other fields are skipped by
/// serde; prompts, instructions, creator IDs and messages are never retained.
fn header_id(reader: impl Read, limit: usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    BufReader::new(reader.take(limit.saturating_add(1) as u64)).read_until(b'\n', &mut line)?;
    if line.len() > limit {
        return Ok(None);
    }
    let bytes = line.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&line);
    let Ok(header) = serde_json::from_slice::<RolloutHeader>(bytes) else {
        return Ok(None);
    };
    if header.kind != "session_meta" {
        return Ok(None);
    }
    Ok(canonical_thread_id(&header.payload.id).ok())
}

fn is_rollout(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with("rollout-")
                && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
        })
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // Reparse points, including junctions.
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

/// No account attribution is performed. The canonical metadata ID wins over
/// segmented/fork/revert filename UUIDs. The newest mtime is retained per thread.
pub fn discover_thread_candidates(
    root: &Path,
    limits: DiscoveryLimits,
) -> io::Result<ThreadCandidateDiscovery> {
    let mut result = ThreadCandidateDiscovery::default();
    if !root.exists() {
        return Ok(result);
    }
    let root_metadata = fs::symlink_metadata(root)?;
    if is_link(&root_metadata) || !root_metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Session root must be a real directory",
        ));
    }
    let root = fs::canonicalize(root)?;
    let mut pending = vec![(root.clone(), 0usize)];
    let mut entries_seen = 0usize;
    let mut files: Vec<PathBuf> = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            result.truncated = true;
            continue;
        };
        for entry in entries {
            if entries_seen >= limits.max_entries.min(100_000) {
                result.truncated = true;
                break;
            }
            entries_seen += 1;
            let Ok(entry) = entry else {
                result.truncated = true;
                continue;
            };
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                result.truncated = true;
                continue;
            };
            if is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                if depth < limits.max_depth.min(8) {
                    pending.push((path, depth + 1));
                } else {
                    result.truncated = true;
                }
            } else if metadata.is_file() && is_rollout(&path) {
                if files.len() >= limits.max_files.min(20_000) {
                    result.truncated = true;
                    break;
                }
                files.push(path);
            }
        }
        if result.truncated
            && (entries_seen >= limits.max_entries.min(100_000)
                || files.len() >= limits.max_files.min(20_000))
        {
            break;
        }
    }
    // Prefer an active uncompressed sibling if both forms briefly coexist.
    let plain: HashSet<_> = files
        .iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .cloned()
        .collect();
    let mut candidates = BTreeMap::<String, u64>::new();
    for path in files {
        let compressed = path.extension().is_some_and(|ext| ext == "zst");
        if compressed && plain.contains(&path.with_extension("")) {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(&path) else {
            result.ignored_files += 1;
            continue;
        };
        if !canonical.starts_with(&root) {
            result.ignored_files += 1;
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            result.ignored_files += 1;
            continue;
        };
        if is_link(&metadata) || !metadata.is_file() {
            result.ignored_files += 1;
            continue;
        }
        result.scanned_files += 1;
        let parsed = (|| -> io::Result<Option<(String, u64)>> {
            let file = File::open(&canonical)?;
            let modified = file
                .metadata()?
                .modified()?
                .duration_since(UNIX_EPOCH)
                .map_err(|_| io::Error::other("Invalid rollout modification time"))?
                .as_millis();
            let modified = u64::try_from(modified)
                .ok()
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| io::Error::other("Unsafe rollout modification time"))?;
            let cap = limits.max_header_bytes.min(MAX_HEADER_BYTES);
            let id = if compressed {
                let mut decoder = zstd::stream::read::Decoder::new(file)?;
                decoder.window_log_max(23)?;
                header_id(decoder, cap)?
            } else {
                header_id(file, cap)?
            };
            Ok(id.map(|id| (id, modified)))
        })();
        match parsed {
            Ok(Some((id, modified))) => {
                candidates
                    .entry(id)
                    .and_modify(|old| *old = (*old).max(modified))
                    .or_insert(modified);
            }
            _ => result.ignored_files += 1,
        }
    }
    result.candidates = candidates
        .into_iter()
        .map(|(thread_id, modified_at_ms)| ThreadCandidate {
            thread_id,
            modified_at_ms,
        })
        .collect();
    result.candidates.sort_by(|left, right| {
        right
            .modified_at_ms
            .cmp(&left.modified_at_ms)
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const THREAD: &str = "019fc8ab-1fb2-7000-8000-000000000123";
    const OTHER: &str = "019fc8ab-1fb2-7000-8000-000000000456";

    fn fixture() -> Value {
        // Matches the official 0.166 active-workspace thread-usage fixture.
        json!({"summary":null,"dailyUsageBuckets":null,"threadUsage":{
        "threadId":THREAD,"estimatedUsageCreditsMicros":46_000_000,
        "estimatedUsageUsdMicros":null,"nativeUsageUsdMicros":null,"groups":[{
            "model":"gpt-5.4","reasoningEffort":"high","speed":"fast",
            "estimatedUsageCreditsMicros":46_000_000,"netNewInputTokens":80,
            "cachedInputTokens":20,"inputTokens":100,"outputTokens":40,"totalTokens":140
        }]}})
    }

    #[test]
    fn parses_exact_official_groups_without_inventing_date_or_cache_creation() {
        let parsed = parse_thread_usage(&THREAD.to_uppercase(), &fixture())
            .unwrap()
            .unwrap();
        assert_eq!(parsed.thread_id, THREAD);
        assert_eq!(parsed.day, None);
        assert_eq!(parsed.groups[0].cached_input_tokens, Some(20));
        assert_eq!(parsed.estimated_usage_usd_micros, None);
        let value = serde_json::to_value(parsed).unwrap();
        assert!(value["groups"][0].get("cacheCreationTokens").is_none());
        assert!(value.get("accountId").is_none());
    }

    #[test]
    fn unavailable_and_real_zero_are_distinct_and_usd_metrics_stay_separate() {
        assert_eq!(parse_thread_usage(THREAD, &json!({})).unwrap(), None);
        assert_eq!(
            parse_thread_usage(THREAD, &json!({"threadUsage":null})).unwrap(),
            None
        );
        let value = json!({"threadUsage":{"threadId":THREAD,"estimatedUsageCreditsMicros":0,
            "estimatedUsageUsdMicros":0,"nativeUsageUsdMicros":750_000,"groups":[]}});
        let parsed = parse_thread_usage(THREAD, &value).unwrap().unwrap();
        assert_eq!(parsed.estimated_usage_usd_micros, Some(0));
        assert_eq!(parsed.native_usage_usd_micros, Some(750_000));
        assert!(parsed.groups.is_empty());
    }

    #[test]
    fn rejects_mismatched_ids_duplicate_groups_and_unsafe_counters() {
        assert!(parse_thread_usage(OTHER, &fixture()).is_err());
        assert!(parse_thread_usage("--invalid", &fixture()).is_err());
        let mut duplicate = fixture();
        duplicate["threadUsage"]["groups"]
            .as_array_mut()
            .unwrap()
            .push(fixture()["threadUsage"]["groups"][0].clone());
        assert!(parse_thread_usage(THREAD, &duplicate).is_err());
        for value in [
            json!(-1),
            json!(1.5),
            json!(MAX_SAFE_INTEGER + 1),
            json!("40"),
        ] {
            let mut invalid = fixture();
            invalid["threadUsage"]["groups"][0]["outputTokens"] = value;
            assert!(parse_thread_usage(THREAD, &invalid).is_err());
        }
        let mut invalid = fixture();
        invalid["threadUsage"]["groups"][0]["cachedInputTokens"] = json!(101);
        assert!(parse_thread_usage(THREAD, &invalid).is_err());
    }

    #[test]
    fn null_components_are_retained_and_model_groups_remain_separate() {
        let mut value = fixture();
        let mut second = value["threadUsage"]["groups"][0].clone();
        second["speed"] = json!("standard");
        second["inputTokens"] = Value::Null;
        value["threadUsage"]["groups"]
            .as_array_mut()
            .unwrap()
            .push(second);
        let parsed = parse_thread_usage(THREAD, &value).unwrap().unwrap();
        assert_eq!(parsed.groups.len(), 2);
        assert!(parsed
            .groups
            .iter()
            .any(|group| group.input_tokens.is_none()));
    }

    #[test]
    fn header_parser_is_bounded_and_never_uses_filenames_or_creator_identity() {
        let header = format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\",\"creator_account_id\":\"not-attribution\"}}}}\n");
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(format!("rollout-{OTHER}.jsonl")),
            format!("{header}unparsed second record\n"),
        )
        .unwrap();
        fs::write(
            temp.path().join(format!("rollout-{OTHER}_{THREAD}.jsonl")),
            &header,
        )
        .unwrap();
        fs::write(
            temp.path().join("rollout-invalid.jsonl"),
            "{\"type\":\"response_item\",\"payload\":{\"id\":\"not-thread\"}}\n",
        )
        .unwrap();
        let result = discover_thread_candidates(temp.path(), DiscoveryLimits::default()).unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].thread_id, THREAD);
        assert!(result.candidates[0].modified_at_ms > 0);
        assert_eq!(result.ignored_files, 1);
        assert!(header_id(header.as_bytes(), 8).unwrap().is_none());
    }

    #[test]
    fn supports_bounded_compressed_headers_and_prefers_active_plain_siblings() {
        let temp = tempfile::tempdir().unwrap();
        let header = format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\"}}}}\n");
        let zst = zstd::stream::encode_all(header.as_bytes(), 3).unwrap();
        fs::write(temp.path().join("rollout-a.jsonl.zst"), &zst).unwrap();
        fs::write(temp.path().join("rollout-b.jsonl.zst"), &zst).unwrap();
        fs::write(
            temp.path().join("rollout-b.jsonl"),
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{OTHER}\"}}}}\n"),
        )
        .unwrap();
        let result = discover_thread_candidates(temp.path(), DiscoveryLimits::default()).unwrap();
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.scanned_files, 2);
        let limited = discover_thread_candidates(
            temp.path(),
            DiscoveryLimits {
                max_files: 1,
                ..DiscoveryLimits::default()
            },
        )
        .unwrap();
        assert!(limited.truncated);
        assert!(limited.scanned_files <= 1);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_directory_links_outside_the_session_root() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(
            outside.path().join("rollout-secret.jsonl"),
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\"}}}}\n"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("linked")).unwrap();
        assert!(
            discover_thread_candidates(temp.path(), DiscoveryLimits::default())
                .unwrap()
                .candidates
                .is_empty()
        );
    }
}
