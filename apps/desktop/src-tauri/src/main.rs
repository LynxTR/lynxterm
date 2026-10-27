// No extra console window on Windows release. Do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod forwards;
mod groups;
mod history;
mod hosts;
mod keys;
mod known_hosts;
mod metrics;
mod onboarding;
mod sftp;
mod snippets;
mod ssh;
mod sync;
mod vault;

/// For `.map_err(err)`: commands return errors to frontend as text.
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// New owner-only file, for vault and private keys (ssh refuses looser ones).
pub fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(err)?;
    file.write_all(bytes).map_err(err)
}

fn main() {
    tauri::Builder::default()
        .manage(ssh::Sessions::default())
        .manage(vault::Vault::default())
        .manage(forwards::Running::default())
        .manage(metrics::Watched::default())
        .invoke_handler(tauri::generate_handler![
            vault::vault_status,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_recover,
            vault::vault_lock,
            vault::vault_erase,
            vault::app_restart,
            vault::item_delete,
            sync::vault_join,
            sync::sync_connect,
            sync::sync_sign_in,
            sync::sync_now,
            sync::sync_pending,
            sync::sync_skipped,
            sync::sync_skip,
            sync::sync_url,
            sync::sync_status,
            ssh::ssh_open,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            history::history_list,
            history::history_save,
            history::history_clear,
            history::ssh_commands,
            history::shell_integration_install,
            history::shell_integration_host,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            keys::keys_list,
            keys::keys_scan,
            keys::key_import,
            keys::key_generate,
            keys::key_export,
            keys::key_install,
            hosts::hosts_list,
            hosts::host_save,
            groups::groups_list,
            groups::group_save,
            snippets::snippets_list,
            snippets::snippet_save,
            forwards::forwards_list,
            forwards::forwards_running,
            forwards::forward_save,
            forwards::forward_delete,
            forwards::forward_start,
            forwards::forward_stop,
            known_hosts::known_hosts_list,
            known_hosts::known_host_delete,
            onboarding::ssh_config_hosts,
            onboarding::open_external,
            onboarding::latest_release,
            activity::activity_list,
            activity::activity_log,
            metrics::metrics,
            metrics::metrics_host,
            metrics::metrics_unwatch
        ])
        .run(tauri::generate_context!())
        .expect("error while running lynxterm");
}
