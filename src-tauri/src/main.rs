mod audio;
mod commands;
mod epub;
mod models;
mod piper_http;
mod queue;
mod repository;
mod runtime;
mod text;
mod updates;

use commands::*;
use queue::QueueManager;
use tauri::Manager;
use updates::*;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let manager = QueueManager::new(app.handle().clone())?;
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_assets,
            cancel_job,
            check_for_update,
            copy_generated_audio,
            delete_generated,
            delete_job,
            download_generated,
            enqueue_epub_files,
            get_generated_audio,
            get_generated_playback_url,
            get_job,
            get_settings,
            install_update,
            list_generated,
            list_jobs,
            list_voices,
            pause_job,
            pick_epub_files,
            reorder_queue,
            resume_job,
            set_settings
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri app");
}
