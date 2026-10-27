//! Local forward, like `ssh -L`: 127.0.0.1:local_port to remote_host:remote_port via host.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;

use crate::ssh;
use crate::vault::{Vault, new_id};

const KIND: &str = "forward";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    #[serde(default)]
    id: String,
    name: String,
    host_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
}

/// Running tunnels by forward id. Aborting task closes listener.
#[derive(Default)]
pub struct Running(Mutex<HashMap<String, JoinHandle<()>>>);

impl Running {
    fn stop(&self, id: &str) {
        if let Some(task) = self.0.lock().unwrap().remove(id) {
            task.abort();
        }
    }
}

#[tauri::command]
pub fn forwards_list(vault: State<'_, Vault>) -> Result<Vec<Forward>, String> {
    let forwards = vault.with(|v| v.list::<Forward>(KIND))?;
    Ok(forwards
        .into_iter()
        .map(|(id, f)| Forward { id, ..f })
        .collect())
}

#[tauri::command]
pub fn forwards_running(running: State<'_, Running>) -> Vec<String> {
    running.0.lock().unwrap().keys().cloned().collect()
}

#[tauri::command]
/// Returns id, generated if new.
pub fn forward_save(vault: State<'_, Vault>, mut forward: Forward) -> Result<String, String> {
    if forward.id.is_empty() {
        forward.id = new_id();
    }
    vault.with(|v| v.put(&forward.id, KIND, &forward))?;
    Ok(forward.id)
}

#[tauri::command]
pub fn forward_delete(
    vault: State<'_, Vault>,
    running: State<'_, Running>,
    id: String,
) -> Result<(), String> {
    running.stop(&id);
    vault.with(|v| v.delete(&id))
}

#[tauri::command]
pub async fn forward_start(
    vault: State<'_, Vault>,
    running: State<'_, Running>,
    id: String,
    password: String,
) -> Result<(), String> {
    let f: Forward = vault.with(|v| v.get(&id))?;
    let (_, session) = ssh::connect_saved(&vault, &f.host_id, &password).await?;
    let session = Arc::new(session);

    // Localhost only: other machines on network can't use tunnel.
    let listener = TcpListener::bind(("127.0.0.1", f.local_port))
        .await
        .map_err(|e| format!("Can't listen on port {}: {e}", f.local_port))?;

    let task = tauri::async_runtime::spawn(async move {
        while let Ok((mut socket, peer)) = listener.accept().await {
            let session = session.clone();
            let target = (f.remote_host.clone(), f.remote_port as u32);
            tauri::async_runtime::spawn(async move {
                let peer_ip = peer.ip().to_string();
                let Ok(channel) = session
                    .channel_open_direct_tcpip(target.0, target.1, peer_ip, peer.port() as u32)
                    .await
                else {
                    return; // server refused this connection; tunnel stays up
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });
    running.stop(&id);
    running.0.lock().unwrap().insert(id, task);
    Ok(())
}

#[tauri::command]
pub fn forward_stop(running: State<'_, Running>, id: String) {
    running.stop(&id);
}
