//! Dedicated manual installer for the compile-time pinned custom channel.
//! Generic upstream installation remains blocked, including JavaScript plugins.
use crate::services::custom_release::{
    self, CustomUpdateCheck, CustomUpdateStatus, ReleaseReview, ResolvedChannel,
};
use chrono::Utc;
use once_cell::sync::Lazy;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

static REVIEW: Lazy<Mutex<Option<ReleaseReview>>> = Lazy::new(|| Mutex::new(None));
static INSTALL: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn channel(app: &AppHandle) -> Result<ResolvedChannel, String> {
    let channel =
        custom_release::pinned_config()?.resolve(&app.package_info().version.to_string())?;
    if app.config().identifier != custom_release::APP_IDENTIFIER {
        return Err(
            "The custom updater cannot replace an application with a different identity".into(),
        );
    }
    Ok(channel)
}

async fn checked_update(
    app: &AppHandle,
    channel: &ResolvedChannel,
) -> Result<Option<Update>, String> {
    let builder = app
        .updater_builder()
        .endpoints(vec![channel.endpoint.clone()])
        .map_err(|_| "Cannot configure the pinned custom update endpoint")?
        .pubkey(channel.public_key.clone())
        .clear_headers()
        .timeout(Duration::from_secs(30))
        .version_comparator(|current, release| release.version > current)
        .configure_client(|client| {
            client
                .https_only(true)
                .danger_accept_invalid_certs(false)
                .danger_accept_invalid_hostnames(false)
        });
    #[cfg(target_os = "windows")]
    let builder = builder.installer_arg("REBOOT=ReallySuppress");
    let update=builder.build().map_err(|_|"Cannot initialize the signed custom updater")?
        .check().await.map_err(|_|"Cannot check the pinned public custom release channel; the current app and accounts are unchanged")?;
    if let Some(update) = &update {
        let info = custom_release::vet_manifest(
            channel,
            &update.raw_json,
            &update.download_url,
            &update.signature,
        )?;
        if info.version != update.version {
            return Err(
                "The custom release manifest version does not match the selected package".into(),
            );
        }
    }
    Ok(update)
}

#[tauri::command]
pub async fn custom_update_status(app: AppHandle) -> Result<CustomUpdateStatus, String> {
    Ok(custom_release::status(
        &app.package_info().version.to_string(),
    ))
}

#[tauri::command]
pub async fn custom_update_check(app: AppHandle) -> Result<CustomUpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let status = custom_release::status(&current);
    if !status.configured {
        return Ok(custom_release::inactive_check(status));
    }
    let channel = channel(&app)?;
    let update = checked_update(&app, &channel).await?;
    let release = match update {
        Some(update) => {
            let info = custom_release::vet_manifest(
                &channel,
                &update.raw_json,
                &update.download_url,
                &update.signature,
            )?;
            *REVIEW.lock().await = Some(custom_release::review_release(
                &info.version,
                &update.raw_json,
                Utc::now().timestamp_millis(),
            )?);
            Some(info)
        }
        None => {
            *REVIEW.lock().await = None;
            None
        }
    };
    Ok(CustomUpdateCheck {
        configured: true,
        available: release.is_some(),
        current_version: current,
        release,
        reason: None,
    })
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn custom_update_install(app: AppHandle, version: String) -> Result<bool, String> {
    let _install = INSTALL
        .try_lock()
        .map_err(|_| "A custom update is already downloading or installing")?;
    let expected = custom_release::custom_version(&version)?.to_string();
    let channel = channel(&app)?;
    let Some(mut update) = checked_update(&app, &channel).await? else {
        return Ok(false);
    };
    if update.version != expected {
        return Err(
            "The available custom version changed; check it again before installing".into(),
        );
    }
    custom_release::require_review(
        REVIEW.lock().await.as_ref(),
        &expected,
        &update.raw_json,
        Utc::now().timestamp_millis(),
    )?;
    // This separate timeout affects only the explicitly requested download.
    update.timeout = Some(Duration::from_secs(10 * 60));
    let progress_app = app.clone();
    let progress_version = expected.clone();
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = progress_app.emit(
                    "custom-update-download-progress",
                    DownloadProgress {
                        version: progress_version.clone(),
                        downloaded,
                        total,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|_| {
            "The signed custom update could not be downloaded or verified; nothing was installed"
        })?;
    // Locked updater2.10 verifies payload+global signature, but does not itself
    // require a signed app version. Enforce that binding before any exit cleanup.
    let signature = update.signature.clone();
    let key = channel.public_key;
    let announced = expected;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        custom_release::verify_versioned_archive(&key, &signature, &bytes, &announced)?;
        Ok::<_, String>(bytes)
    })
    .await
    .map_err(|_| "Cannot verify the version-bound custom archive")??;
    *REVIEW.lock().await = None;

    #[cfg(target_os = "windows")]
    {
        // Preserve the existing updater's cleanup/restart lifecycle and MSI's
        // no-system-reboot policy. No account logout/removal methods are called.
        crate::save_window_state_before_exit(&app);
        crate::cleanup_before_exit(&app).await;
        crate::remove_tray_icon_before_exit(&app);
        crate::destroy_single_instance_lock(&app);
        tokio::time::sleep(Duration::from_millis(100)).await;
        update.install(bytes).map_err(|_|"The verified custom installer could not start. Restart CC Switch; accounts and analytics remain in their existing configuration directory")?;
        Ok(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        update.install(bytes).map_err(|_|"The verified custom update could not be installed; account data was not moved or deleted")?;
        crate::save_window_state_before_exit(&app);
        crate::cleanup_before_exit(&app).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        crate::restart_process(&app);
    }
}
