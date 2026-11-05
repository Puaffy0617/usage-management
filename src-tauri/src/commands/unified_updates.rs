use crate::services::unified_updates::{self, UnifiedUpdateStatus};

#[tauri::command]
pub async fn unified_update_status() -> Result<UnifiedUpdateStatus, String> {
    unified_updates::status().await
}

#[tauri::command]
pub async fn unified_update_configure(
    source_dir: Option<String>,
    auto_prepare: bool,
) -> Result<UnifiedUpdateStatus, String> {
    unified_updates::configure(source_dir, auto_prepare).await
}

#[tauri::command]
pub async fn unified_update_prepare(target_version: String) -> Result<UnifiedUpdateStatus, String> {
    unified_updates::prepare(target_version).await
}

#[tauri::command]
pub async fn unified_update_on_upstream_available(
    version: String,
) -> Result<UnifiedUpdateStatus, String> {
    unified_updates::on_upstream_available(version).await
}
