use std::{fs, path::Path};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::{
    models::{AppSettings, GeneratedAudio, JobDetail, QueueJob, VoiceInfo},
    queue::QueueManager,
};

type CommandResult<T> = Result<T, String>;

fn command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub fn pick_epub_files(app: AppHandle) -> CommandResult<Vec<String>> {
    let files = app
        .dialog()
        .file()
        .add_filter("EPUB files", &["epub"])
        .blocking_pick_files()
        .unwrap_or_default();
    files
        .into_iter()
        .map(|file| {
            file.into_path()
                .map(|path| path.to_string_lossy().to_string())
                .map_err(command_error)
        })
        .collect()
}

#[tauri::command]
pub fn enqueue_epub_files(
    manager: State<'_, QueueManager>,
    file_paths: Vec<String>,
) -> CommandResult<Vec<QueueJob>> {
    manager
        .enqueue_epub_files(file_paths)
        .map_err(command_error)
}

#[tauri::command]
pub fn list_jobs(manager: State<'_, QueueManager>) -> CommandResult<Vec<QueueJob>> {
    manager.repo().list_jobs().map_err(command_error)
}

#[tauri::command]
pub fn get_job(
    manager: State<'_, QueueManager>,
    job_id: String,
) -> CommandResult<Option<JobDetail>> {
    manager
        .repo()
        .get_job_detail(&job_id)
        .map_err(command_error)
}

#[tauri::command]
pub fn reorder_queue(
    manager: State<'_, QueueManager>,
    job_ids_in_order: Vec<String>,
) -> CommandResult<Vec<QueueJob>> {
    manager
        .repo()
        .reorder_queue(&job_ids_in_order)
        .and_then(|_| manager.repo().list_jobs())
        .map_err(command_error)
}

#[tauri::command]
pub fn pause_job(
    manager: State<'_, QueueManager>,
    job_id: String,
) -> CommandResult<Option<JobDetail>> {
    manager.pause_job(&job_id).map_err(command_error)
}

#[tauri::command]
pub fn resume_job(
    manager: State<'_, QueueManager>,
    job_id: String,
) -> CommandResult<Option<JobDetail>> {
    manager.resume_job(&job_id).map_err(command_error)
}

#[tauri::command]
pub fn cancel_job(
    manager: State<'_, QueueManager>,
    job_id: String,
) -> CommandResult<Option<JobDetail>> {
    manager.cancel_job(&job_id).map_err(command_error)
}

#[tauri::command]
pub fn delete_job(
    manager: State<'_, QueueManager>,
    job_id: String,
    delete_outputs: Option<bool>,
) -> CommandResult<Vec<QueueJob>> {
    if delete_outputs.unwrap_or(false) {
        for output in manager
            .repo()
            .get_outputs_by_job(&job_id)
            .map_err(command_error)?
        {
            let _ = fs::remove_file(output.file_path);
        }
    }
    manager
        .repo()
        .delete_job(&job_id)
        .and_then(|_| manager.repo().list_jobs())
        .map_err(command_error)
}

#[tauri::command]
pub fn list_generated(manager: State<'_, QueueManager>) -> CommandResult<Vec<GeneratedAudio>> {
    manager.repo().list_outputs().map_err(command_error)
}

#[tauri::command]
pub fn get_generated_audio(
    manager: State<'_, QueueManager>,
    output_id: String,
) -> CommandResult<Option<GeneratedAudio>> {
    manager.repo().get_output(&output_id).map_err(command_error)
}

#[tauri::command]
pub fn delete_generated(
    manager: State<'_, QueueManager>,
    output_id: String,
) -> CommandResult<Vec<GeneratedAudio>> {
    if let Some(output) = manager
        .repo()
        .get_output(&output_id)
        .map_err(command_error)?
    {
        let _ = fs::remove_file(output.file_path);
    }
    manager
        .repo()
        .delete_output(&output_id)
        .and_then(|_| manager.repo().list_outputs())
        .map_err(command_error)
}

#[tauri::command]
pub fn get_generated_playback_url(
    manager: State<'_, QueueManager>,
    output_id: String,
) -> CommandResult<String> {
    manager
        .repo()
        .get_output(&output_id)
        .map_err(command_error)?
        .map(|output| output.file_path)
        .ok_or_else(|| "Generated audio not found.".to_string())
}

fn copy_generated_output(
    manager: State<'_, QueueManager>,
    output_id: &str,
    destination_path: &str,
) -> CommandResult<()> {
    let output = manager
        .repo()
        .get_output(output_id)
        .map_err(command_error)?
        .ok_or_else(|| "Generated audio not found.".to_string())?;
    fs::copy(output.file_path, destination_path)
        .map(|_| ())
        .map_err(command_error)
}

#[tauri::command]
pub fn download_generated(
    manager: State<'_, QueueManager>,
    output_id: String,
    destination_path: String,
) -> CommandResult<()> {
    copy_generated_output(manager, &output_id, &destination_path)
}

#[tauri::command]
pub fn copy_generated_audio(
    manager: State<'_, QueueManager>,
    output_id: String,
    destination_path: String,
) -> CommandResult<()> {
    copy_generated_output(manager, &output_id, &destination_path)
}

#[tauri::command]
pub fn get_settings(manager: State<'_, QueueManager>) -> CommandResult<AppSettings> {
    manager.repo().get_settings().map_err(command_error)
}

#[tauri::command]
pub fn set_settings(
    manager: State<'_, QueueManager>,
    patch: AppSettings,
) -> CommandResult<AppSettings> {
    manager.set_settings(patch).map_err(command_error)
}

#[tauri::command]
pub fn list_voices(manager: State<'_, QueueManager>) -> CommandResult<Vec<VoiceInfo>> {
    Ok(manager.list_voices())
}

#[allow(dead_code)]
fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}
