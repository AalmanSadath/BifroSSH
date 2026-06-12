mod commands;
mod crypto;
mod models;
mod ssh;
mod store;

use std::sync::Arc;
use commands::AppState;
use ssh::SshState;
use store::{load_app_data, load_secret_key};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let secret_key = load_secret_key().expect("Failed to load/generate secret key");
    let app_data = load_app_data().expect("Failed to load app data");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            data: tokio::sync::Mutex::new(app_data),
            secret_key,
            ssh_state: Arc::new(SshState::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_servers,
            commands::save_server,
            commands::delete_server,
            commands::list_keys,
            commands::import_key_from_path,
            commands::save_key_from_content,
            commands::generate_key,
            commands::delete_key,
            commands::list_identities,
            commands::save_identity,
            commands::delete_identity,
            commands::get_settings,
            commands::save_settings,
            commands::ssh_connect,
            commands::ssh_send_input,
            commands::ssh_resize,
            commands::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("Error running BifroSSH");
}
