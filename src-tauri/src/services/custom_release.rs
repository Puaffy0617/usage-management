//! Compile-time trust policy for the owner's public signed custom releases.
//! This module reads no credentials, environment variables or mutable settings.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

pub const EDITION: &str = "cc-switch-unified-usage";
pub const APP_IDENTIFIER: &str = "com.ccswitch.desktop";
const PINNED_CONFIG: &str = include_str!("../../../customization/release-channel.json");
// Upstream's public key must never authorize replacement of this custom edition.
const STOCK_PUBLIC_KEY:&str="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM4MDI4QzlBNTczOTI4RTMKUldUaktEbFhtb3dDeUM5US9kT0FmdGR5Ti9vQzcwa2dTMlpibDVDUmQ2M0VGTzVOWnd0SGpFVlEK";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelConfig {
    pub edition: String,
    pub enabled: bool,
    pub repository: Option<String>,
    pub public_key: Option<String>,
    pub channel: String,
    pub version: Option<String>,
}

#[derive(Clone)]
pub struct ResolvedChannel {
    pub repository: String,
    pub public_key: String,
    pub version: Version,
    pub endpoint: Url,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomUpdateStatus {
    pub configured: bool,
    pub edition: String,
    pub repository: Option<String>,
    pub channel: String,
    pub current_version: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomReleaseInfo {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomUpdateCheck {
    pub configured: bool,
    pub available: bool,
    pub current_version: String,
    pub release: Option<CustomReleaseInfo>,
    pub reason: Option<String>,
}

pub struct ReleaseReview {
    version: String,
    manifest_hash: [u8; 32],
    checked_at: i64,
}

pub fn review_release(version: &str, manifest: &Value, now: i64) -> Result<ReleaseReview, String> {
    let bytes =
        serde_json::to_vec(manifest).map_err(|_| "Cannot record the checked custom release")?;
    Ok(ReleaseReview {
        version: version.into(),
        manifest_hash: Sha256::digest(bytes).into(),
        checked_at: now,
    })
}

pub fn require_review(
    review: Option<&ReleaseReview>,
    version: &str,
    manifest: &Value,
    now: i64,
) -> Result<(), String> {
    let review = review.ok_or("Check the custom release before choosing Install")?;
    let age = now.saturating_sub(review.checked_at);
    if review.version != version || now < review.checked_at || age > 30 * 60 * 1000 {
        return Err("Check custom updates again before installing this version".into());
    }
    let bytes =
        serde_json::to_vec(manifest).map_err(|_| "Cannot inspect the checked custom release")?;
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    if digest != review.manifest_hash {
        return Err(
            "The custom release changed after it was checked; check it again before installing"
                .into(),
        );
    }
    Ok(())
}

pub fn custom_version(raw: &str) -> Result<Version, String> {
    if raw.len() > 96 {
        return Err("The custom release version is too long".into());
    }
    let version = Version::parse(raw)
        .map_err(|_| "The custom release version is not valid SemVer".to_owned())?;
    let parts = version.pre.as_str().split('.').collect::<Vec<_>>();
    if !version.build.is_empty()
        || parts.len() != 2
        || parts[0] != "usage"
        || parts[1]
            .parse::<u64>()
            .ok()
            .is_none_or(|revision| revision == 0)
    {
        return Err("Custom releases require a version such as 4.0.25-usage.1".into());
    }
    Ok(version)
}

fn validate_repository(repository: &str) -> Result<(), String> {
    let parts = repository.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts[0].is_empty()
        || parts[0].len() > 39
        || parts[1].is_empty()
        || parts[1].len() > 100
        || [".", ".."].contains(&parts[1])
        || !parts[0]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        || parts[0].starts_with('-')
        || parts[0].ends_with('-')
        || !parts[1]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || repository.eq_ignore_ascii_case("farion1231/cc-switch")
    {
        return Err("Pin an owner's public GitHub repository as owner/repository, distinct from stock CC Switch".into());
    }
    Ok(())
}

fn decoded_text(raw: &str, limit: usize) -> Result<String, String> {
    if raw.len() > limit {
        return Err("The pinned signing metadata is too large".into());
    }
    let bytes = STANDARD
        .decode(raw)
        .map_err(|_| "Signing metadata must use Tauri's base64 Minisign format".to_owned())?;
    String::from_utf8(bytes)
        .map_err(|_| "Signing metadata must contain a UTF-8 Minisign document".into())
}

fn public_key(raw: &str) -> Result<PublicKey, String> {
    let text = decoded_text(raw, 4096)?;
    if text.lines().count() != 2 || !text.starts_with("untrusted comment: ") {
        return Err("Pin a Minisign public key, never a private signing key".into());
    }
    let key = PublicKey::decode(&text)
        .map_err(|_| "The pinned Minisign public key is invalid".to_owned())?;
    let material = STANDARD
        .decode(
            text.lines()
                .nth(1)
                .ok_or("The public key document is incomplete")?,
        )
        .map_err(|_| "The public key material is invalid")?;
    let stock_text = decoded_text(STOCK_PUBLIC_KEY, 4096)?;
    let stock_material = STANDARD
        .decode(
            stock_text
                .lines()
                .nth(1)
                .ok_or("Cannot inspect the stock public-key exclusion")?,
        )
        .map_err(|_| "Cannot inspect the stock public-key exclusion")?;
    if material.get(10..) == stock_material.get(10..) {
        return Err("The upstream public-key material cannot authorize this custom edition".into());
    }
    Ok(key)
}

pub fn parse_config(raw: &str) -> Result<ChannelConfig, String> {
    if raw.len() > 16 * 1024 {
        return Err("The compile-time release-channel configuration is too large".into());
    }
    let config: ChannelConfig = serde_json::from_str(raw)
        .map_err(|_| "The compile-time release-channel configuration is invalid".to_owned())?;
    if config.edition != EDITION || config.channel != "stable" {
        return Err("Only this custom edition's pinned stable release channel is supported".into());
    }
    if let Some(repository) = &config.repository {
        validate_repository(repository)?;
    }
    if let Some(key) = &config.public_key {
        if key == STOCK_PUBLIC_KEY {
            return Err("A separate custom signing public key is required; the upstream key is not accepted".into());
        }
        public_key(key)?;
    }
    if let Some(version) = &config.version {
        custom_version(version)?;
    }
    Ok(config)
}

impl ChannelConfig {
    pub fn resolve(&self, current_version: &str) -> Result<ResolvedChannel, String> {
        if !self.enabled {
            return Err("Hosted custom updates are disabled in this build; no signed release channel has been activated".into());
        }
        let repository = self
            .repository
            .clone()
            .ok_or("The custom repository is not pinned in this build")?;
        validate_repository(&repository)?;
        let key = self
            .public_key
            .clone()
            .ok_or("The custom signing public key is not pinned in this build")?;
        if key == STOCK_PUBLIC_KEY {
            return Err("The stock signing key cannot authorize custom releases".into());
        }
        public_key(&key)?;
        let version = custom_version(
            self.version
                .as_deref()
                .ok_or("The custom package version is not pinned in this build")?,
        )?;
        if version.to_string() != current_version {
            return Err("The pinned custom version does not match the running package; rebuild the correctly versioned custom release".into());
        }
        let endpoint = Url::parse(&format!(
            "https://github.com/{repository}/releases/latest/download/latest.json"
        ))
        .map_err(|_| "Cannot derive the pinned public release endpoint")?;
        Ok(ResolvedChannel {
            repository,
            public_key: key,
            version,
            endpoint,
        })
    }
}

pub fn pinned_config() -> Result<ChannelConfig, String> {
    parse_config(PINNED_CONFIG)
}

pub fn status(current_version: &str) -> CustomUpdateStatus {
    let config = pinned_config();
    let (repository, reason) = match config {
        Ok(config) => {
            let reason = config.resolve(current_version).err();
            (config.repository, reason)
        }
        Err(reason) => (None, Some(reason)),
    };
    CustomUpdateStatus {
        configured: reason.is_none(),
        edition: EDITION.into(),
        repository,
        channel: "stable".into(),
        current_version: current_version.into(),
        reason,
    }
}

pub fn inactive_check(status: CustomUpdateStatus) -> CustomUpdateCheck {
    CustomUpdateCheck {
        configured: status.configured,
        available: false,
        current_version: status.current_version,
        release: None,
        reason: status.reason,
    }
}

fn signed_version(signature: &Signature, announced: &str) -> Result<(), String> {
    let versions = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|field| field.strip_prefix("version:"))
        .collect::<Vec<_>>();
    if versions.len() != 1 {
        return Err(
            "The update signature must bind exactly one app version; sign it with --app-version"
                .into(),
        );
    }
    let signed = Version::parse(versions[0].strip_prefix('v').unwrap_or(versions[0]))
        .map_err(|_| "The signature's app version is invalid".to_owned())?;
    let announced =
        Version::parse(announced).map_err(|_| "The announced app version is invalid".to_owned())?;
    if signed != announced {
        return Err("The signed archive belongs to a different app version; update refused".into());
    }
    Ok(())
}

fn signature(raw: &str, announced: &str) -> Result<Signature, String> {
    let text = decoded_text(raw, 16 * 1024)?;
    if text.lines().count() != 4 {
        return Err("The update signature is not a complete Minisign document".into());
    }
    let signature =
        Signature::decode(&text).map_err(|_| "The update signature is invalid".to_owned())?;
    signed_version(&signature, announced)?;
    Ok(signature)
}

/// Additional version-bound verification for the locked updater 2.10 API.
/// Minisign verifies both payload and the trusted comment's global signature.
pub fn verify_versioned_archive(
    key: &str,
    signature_text: &str,
    bytes: &[u8],
    announced: &str,
) -> Result<(), String> {
    let key = public_key(key)?;
    let signature = signature(signature_text, announced)?;
    key.verify(bytes, &signature, false).map_err(|_| {
        "The custom archive or signed version failed verification; nothing was installed".into()
    })
}

fn allowed_asset(channel: &ResolvedChannel, url: &Url, version: &str) -> Result<(), String> {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Custom update artifacts must use the pinned public GitHub HTTPS release repository"
                .into(),
        );
    }
    let prefix = format!("/{}/releases/download/v{version}/", channel.repository);
    let name = url
        .path()
        .strip_prefix(&prefix)
        .ok_or("The update artifact points to another repository or release version")?;
    if name.is_empty()
        || name.len() > 240
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        || [".", ".."].contains(&name)
    {
        return Err("The custom update asset name is invalid".into());
    }
    Ok(())
}

pub fn vet_manifest(
    channel: &ResolvedChannel,
    raw: &Value,
    selected_url: &Url,
    selected_signature: &str,
) -> Result<CustomReleaseInfo, String> {
    if serde_json::to_vec(raw)
        .map_err(|_| "Cannot inspect the custom release manifest")?
        .len()
        > 256 * 1024
    {
        return Err("The custom release manifest is too large".into());
    }
    for (key, expected) in [
        ("edition", EDITION),
        ("repository", channel.repository.as_str()),
        ("channel", "stable"),
    ] {
        if raw.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(format!(
                "The release manifest's {key} does not match this pinned custom channel"
            ));
        }
    }
    let raw_version = raw
        .get("version")
        .and_then(Value::as_str)
        .ok_or("The custom release manifest has no version")?;
    let version = custom_version(raw_version)?;
    if version <= channel.version {
        return Err(
            "The custom release is not newer than the running version; downgrades are refused"
                .into(),
        );
    }
    let platforms = raw
        .get("platforms")
        .and_then(Value::as_object)
        .filter(|platforms| !platforms.is_empty() && platforms.len() <= 24)
        .ok_or("A bounded static platform manifest is required for custom updates")?;
    let mut selected = false;
    for (platform, asset) in platforms {
        if platform.len() > 80
            || !platform
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err("The custom platform identifier is invalid".into());
        }
        let url = Url::parse(
            asset
                .get("url")
                .and_then(Value::as_str)
                .ok_or("The custom update platform has no download URL")?,
        )
        .map_err(|_| "The custom update platform URL is invalid")?;
        allowed_asset(channel, &url, raw_version)?;
        let sig = asset
            .get("signature")
            .and_then(Value::as_str)
            .ok_or("The custom update platform has no signature")?;
        signature(sig, raw_version)?;
        selected |= &url == selected_url && sig == selected_signature;
    }
    if !selected {
        return Err(
            "The selected update package was not listed in the pinned custom manifest".into(),
        );
    }
    let notes = raw
        .get("notes")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(8000).collect());
    let pub_date = raw
        .get("pub_date")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 64)
        .map(str::to_owned);
    Ok(CustomReleaseInfo {
        version: version.to_string(),
        notes,
        pub_date,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    // Public test vectors from tauri-apps/plugins-workspace updater offline_tests
    // (MIT/Apache-2.0). No private key is present or generated.
    const KEY:&str="untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
    const SIG:&str="untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
    fn configured() -> ResolvedChannel {
        parse_config(&json!({"edition":EDITION,"enabled":true,"repository":"Example/usage-management","publicKey":STANDARD.encode(KEY),"channel":"stable","version":"4.0.25-usage.1"}).to_string()).unwrap().resolve("4.0.25-usage.1").unwrap()
    }
    fn manifest() -> Value {
        // Metadata policy fixture only: archive verification is tested separately
        // with the real public vector; modified comments never pass crypto.
        json!({"edition":EDITION,"repository":"Example/usage-management","channel":"stable","version":"4.0.25-usage.2","platforms":{"windows-x86_64":{"url":"https://github.com/Example/usage-management/releases/download/v4.0.25-usage.2/setup.exe","signature":STANDARD.encode(SIG.replace("version:2.0.0","version:4.0.25-usage.2"))}}})
    }
    fn selected(document: &Value) -> (Url, String) {
        (
            Url::parse(
                document["platforms"]["windows-x86_64"]["url"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
            document["platforms"]["windows-x86_64"]["signature"]
                .as_str()
                .unwrap()
                .into(),
        )
    }

    #[test]
    fn disabled_channel_is_safe_and_version_pin_must_match_package() {
        let disabled=parse_config(r#"{"edition":"cc-switch-unified-usage","enabled":false,"repository":null,"publicKey":null,"channel":"stable","version":null}"#).unwrap();
        assert!(disabled.resolve("4.0.25").is_err());
        let mut config=parse_config(&json!({"edition":EDITION,"enabled":true,"repository":"Example/usage-management","publicKey":STANDARD.encode(KEY),"channel":"stable","version":"4.0.25-usage.1"}).to_string()).unwrap();
        assert!(config.resolve("4.0.25").is_err());
        config.public_key = None;
        assert!(config.resolve("4.0.25-usage.1").is_err());
        for bad in [
            "4.0.25",
            "4.0.25-usage.0",
            "4.0.25-usage.01",
            "4.0.25-usage.1+mutable",
            "4.0.25-beta.1",
        ] {
            assert!(custom_version(bad).is_err());
        }
    }

    #[test]
    fn trust_pins_reject_stock_keys_repositories_and_runtime_endpoint_fields() {
        for repository in [
            "farion1231/cc-switch",
            "https://github.com/Example/usage-management",
            "Example/usage management",
            "Example/usage-management/extra",
            "Example/..",
        ] {
            assert!(validate_repository(repository).is_err());
        }
        let config = json!({"edition":EDITION,"enabled":true,"repository":"Example/usage-management","publicKey":STOCK_PUBLIC_KEY,"channel":"stable","version":"4.0.25-usage.1"});
        assert!(parse_config(&config.to_string()).is_err());
        let mut altered = config;
        altered["publicKey"] = json!(STANDARD.encode(KEY));
        altered["endpoint"] = json!("https://attacker.invalid/latest.json");
        assert!(parse_config(&altered.to_string()).is_err());
        assert_eq!(
            configured().endpoint.as_str(),
            "https://github.com/Example/usage-management/releases/latest/download/latest.json"
        );
    }

    #[test]
    fn public_crypto_vector_rejects_tampered_payload_comment_and_version() {
        let key = STANDARD.encode(KEY);
        let signature = STANDARD.encode(SIG);
        verify_versioned_archive(&key, &signature, b"test", "2.0.0").unwrap();
        assert!(verify_versioned_archive(&key, &signature, b"tampered", "2.0.0").is_err());
        assert!(verify_versioned_archive(&key, &signature, b"test", "2.0.1").is_err());
        let renamed = STANDARD.encode(SIG.replace("version:2.0.0", "version:2.0.1"));
        assert!(verify_versioned_archive(&key, &renamed, b"test", "2.0.1").is_err());
        let unsigned_version = STANDARD.encode(SIG.replace("\tversion:2.0.0", ""));
        assert!(verify_versioned_archive(&key, &unsigned_version, b"test", "2.0.0").is_err());
    }

    #[test]
    fn manifest_vetting_rejects_wrong_edition_downgrade_and_unlisted_package() {
        let channel = configured();
        let document = manifest();
        let (url, sig) = selected(&document);
        assert_eq!(
            vet_manifest(&channel, &document, &url, &sig)
                .unwrap()
                .version,
            "4.0.25-usage.2"
        );
        for field in ["edition", "repository", "channel"] {
            let mut bad = document.clone();
            bad[field] = json!("other");
            assert!(vet_manifest(&channel, &bad, &url, &sig).is_err());
        }
        let mut downgrade = document.clone();
        downgrade["version"] = json!("4.0.25-usage.1");
        assert!(vet_manifest(&channel, &downgrade, &url, &sig).is_err());
        assert!(vet_manifest(&channel,&document,&Url::parse("https://github.com/Example/usage-management/releases/download/v4.0.25-usage.2/other.exe").unwrap(),&sig).is_err());
    }

    #[test]
    fn every_platform_asset_stays_on_pinned_https_repository_and_release() {
        let channel = configured();
        let original = manifest();
        for bad_url in ["http://github.com/Example/usage-management/releases/download/v4.0.25-usage.2/setup.exe","https://github.com/attacker/usage-management/releases/download/v4.0.25-usage.2/setup.exe","https://github.com/Example/usage-management/releases/download/v4.0.24-usage.1/setup.exe","https://github.com/Example/usage-management/releases/download/v4.0.25-usage.2/setup.exe?token=secret","https://user:secret@github.com/Example/usage-management/releases/download/v4.0.25-usage.2/setup.exe"] {
            let mut document=original.clone();document["platforms"]["darwin-aarch64"]=json!({"url":bad_url,"signature":original["platforms"]["windows-x86_64"]["signature"]});let (url,sig)=selected(&document);assert!(vet_manifest(&channel,&document,&url,&sig).is_err());
        }
    }

    #[test]
    fn install_requires_recent_review_of_the_same_release_manifest() {
        let document = manifest();
        let review = review_release("4.0.25-usage.2", &document, 1000).unwrap();
        require_review(Some(&review), "4.0.25-usage.2", &document, 2000).unwrap();
        assert!(require_review(None, "4.0.25-usage.2", &document, 2000).is_err());
        assert!(require_review(Some(&review), "4.0.25-usage.3", &document, 2000).is_err());
        assert!(require_review(
            Some(&review),
            "4.0.25-usage.2",
            &document,
            30 * 60 * 1000 + 1001
        )
        .is_err());
        let mut changed = document;
        changed["notes"] = json!("Changed release");
        assert!(require_review(Some(&review), "4.0.25-usage.2", &changed, 2000).is_err());
    }
}
