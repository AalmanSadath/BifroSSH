mod commands;
mod crypto;
mod hostkeys;
mod jump;
mod models;
mod ppk;
mod prompts;
mod sftp;
mod sshconfig;
mod ssh;
#[cfg(test)]
mod agent_tests;
#[cfg(test)]
mod ssh_auth_tests;
mod store;
mod tunnel;

use std::sync::Arc;
use commands::AppState;
use prompts::PromptState;
use sftp::SftpClientState;
use ssh::SshState;
use store::{load_app_data, load_secret_key};
use tunnel::TunnelState;

/// The webview keeps its storage in a directory named after the app
/// identifier, so renaming the identifier strands whatever WebKit had put
/// under the old name. That matters because localStorage is in there, and
/// appStore.ts still migrates port forwardings, codeprints and custom themes
/// out of localStorage for anyone upgrading from a version before 0.5.0. A
/// fresh directory would leave the migration nothing to find and quietly lose
/// all three.
///
/// Renaming the directory has to happen before the webview opens it, so this
/// runs first thing. Linux only: the identifier is not what names this
/// directory on the other platforms, and BifroSSH only ships for Linux.
#[cfg(target_os = "linux")]
fn migrate_webview_data_dir() {
    const OLD_IDENTIFIER: &str = "com.bifrossh.app";
    const NEW_IDENTIFIER: &str = "io.github.aalmansadath.bifrossh";

    let Some(base) = dirs::data_dir() else { return };
    let (old, new) = (base.join(OLD_IDENTIFIER), base.join(NEW_IDENTIFIER));

    // An existing new directory means this already ran, or the user has never
    // been on an older version. Either way the old one is not ours to touch.
    if !old.is_dir() || new.exists() {
        return;
    }
    if let Err(e) = std::fs::rename(&old, &new) {
        // Not fatal. The cost is a webview that starts out empty, which loses
        // the pre-0.5.0 localStorage migration but nothing that is already in
        // data.json, so carrying on beats refusing to launch.
        eprintln!("Could not move webview data from {OLD_IDENTIFIER} to {NEW_IDENTIFIER}: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    migrate_webview_data_dir();

    let secret_key = load_secret_key().expect("Failed to load/generate secret key");
    let app_data = load_app_data().expect("Failed to load app data");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            data: tokio::sync::Mutex::new(app_data),
            secret_key,
            ssh_state: Arc::new(SshState::new()),
            sftp_state: Arc::new(SftpClientState::new()),
            tunnel_state: Arc::new(TunnelState::new()),
            prompts: Arc::new(PromptState::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_servers,
            commands::save_server,
            commands::get_server_password,
            commands::delete_server,
            commands::list_keys,
            commands::import_key_from_path,
            commands::save_key_from_content,
            commands::generate_key,
            commands::get_key_content,
            commands::update_key,
            commands::delete_key,
            commands::list_identities,
            commands::save_identity,
            commands::delete_identity,
            commands::get_identity_password,
            commands::get_settings,
            commands::save_settings,
            commands::scan_ssh_config,
            commands::import_ssh_config_hosts,
            commands::get_port_forwardings,
            commands::save_port_forwardings,
            commands::get_codeprints,
            commands::save_codeprints,
            commands::get_custom_themes,
            commands::save_custom_themes,
            commands::respond_host_key,
            commands::respond_auth_prompt,
            commands::list_known_hosts,
            commands::list_agent_keys,
            commands::forget_known_host,
            commands::convert_ppk,
            commands::detect_server_os,
            commands::ssh_connect,
            commands::ssh_connect_quick,
            commands::ssh_send_input,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::sftp_local_home,
            commands::sftp_list_local,
            commands::sftp_connect_remote,
            commands::sftp_get_home,
            commands::sftp_list_remote,
            commands::sftp_disconnect_remote,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_copy_remote_to_remote,
            commands::sftp_create_local_dir,
            commands::sftp_mkdir,
            commands::sftp_delete_local,
            commands::sftp_rename_local,
            commands::sftp_delete_remote,
            commands::sftp_rename_remote,
            commands::tunnel_start,
            commands::tunnel_stop,
        ])
        .run(tauri::generate_context!())
        .expect("Error running BifroSSH");
}
