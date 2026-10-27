use serde::{Deserialize, Serialize};
use tauri::State;

use crate::vault::{Vault, new_id};

pub const KIND: &str = "host";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    /// Empty when saving a new host.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_id: String,
    /// Server OS id (debian, ubuntu…), for logo; empty until seen.
    #[serde(default)]
    pub os: String,
    /// Free labels (nginx, customer-acme…), lowercase.
    #[serde(default)]
    pub tags: Vec<String>,
}

#[tauri::command]
pub fn hosts_list(vault: State<'_, Vault>) -> Result<Vec<Host>, String> {
    let hosts = vault.with(|v| v.list::<Host>(KIND))?;
    Ok(hosts.into_iter().map(|(id, h)| Host { id, ..h }).collect())
}

#[tauri::command]
pub fn host_save(vault: State<'_, Vault>, mut host: Host) -> Result<(), String> {
    if host.id.is_empty() {
        host.id = new_id();
    }
    vault.with(|v| v.put(&host.id, KIND, &host))
}
