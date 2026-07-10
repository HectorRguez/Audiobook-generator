use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

impl From<&Update> for UpdateInfo {
    fn from(update: &Update) -> Self {
        Self {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            notes: update.body.clone(),
            date: update.date.map(|value| value.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    phase: String,
    version: Option<String>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: Option<String>,
}

fn emit_status(app: &AppHandle, status: UpdateStatus) {
    let _ = app.emit("updateStatusUpdated", status);
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.as_ref().map(UpdateInfo::from))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No update is currently available.".to_string())?;
    let version = update.version.clone();

    emit_status(
        &app,
        UpdateStatus {
            phase: "downloading".to_string(),
            version: Some(version.clone()),
            downloaded_bytes: Some(0),
            total_bytes: None,
            message: None,
        },
    );

    let progress_app = app.clone();
    let progress_version = version.clone();
    let finish_app = app.clone();
    let finish_version = version.clone();
    let mut downloaded_bytes = 0_u64;
    let result = update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                emit_status(
                    &progress_app,
                    UpdateStatus {
                        phase: "downloading".to_string(),
                        version: Some(progress_version.clone()),
                        downloaded_bytes: Some(downloaded_bytes),
                        total_bytes: content_length,
                        message: None,
                    },
                );
            },
            move || {
                emit_status(
                    &finish_app,
                    UpdateStatus {
                        phase: "installing".to_string(),
                        version: Some(finish_version),
                        downloaded_bytes: None,
                        total_bytes: None,
                        message: None,
                    },
                );
            },
        )
        .await;

    if let Err(error) = result {
        let message = error.to_string();
        emit_status(
            &app,
            UpdateStatus {
                phase: "error".to_string(),
                version: Some(version),
                downloaded_bytes: None,
                total_bytes: None,
                message: Some(message.clone()),
            },
        );
        return Err(message);
    }

    app.restart();
}
