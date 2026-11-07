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
    /// Kept only when user saves it. Never sent to frontend.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    /// hosts_list only, instead of password.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub saved_password: bool,
}

fn find(
    vault: &Vault,
    host: &str,
    port: u16,
    user: &str,
) -> Result<Option<(String, Host)>, String> {
    let hosts = vault.with(|v| v.list::<Host>(KIND))?;
    Ok(hosts
        .into_iter()
        .find(|(_, h)| h.host == host && h.port == port && h.user == user))
}

/// Empty if none.
pub fn saved_password(vault: &Vault, host: &str, port: u16, user: &str) -> Result<String, String> {
    Ok(find(vault, host, port, user)?.map_or_else(String::new, |(_, h)| h.password))
}

#[tauri::command]
pub fn hosts_list(vault: State<'_, Vault>) -> Result<Vec<Host>, String> {
    let hosts = vault.with(|v| v.list::<Host>(KIND))?;
    Ok(hosts
        .into_iter()
        .map(|(id, h)| Host {
            id,
            saved_password: !h.password.is_empty(),
            password: String::new(),
            ..h
        })
        .collect())
}

#[tauri::command]
pub fn host_save(vault: State<'_, Vault>, mut host: Host) -> Result<(), String> {
    if host.id.is_empty() {
        host.id = new_id();
    } else if let Ok(old) = vault.with(|v| v.get::<Host>(&host.id)) {
        host.password = old.password; // frontend never has it
    }
    host.saved_password = false;
    vault.with(|v| v.put(&host.id, KIND, &host))
}

/// Empty forgets. Unsaved host: nothing kept.
#[tauri::command]
pub fn host_password_save(
    vault: State<'_, Vault>,
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<(), String> {
    let Some((id, mut h)) = find(&vault, &host, port, &user)? else {
        return Ok(());
    };
    h.password = password;
    vault.with(|v| v.put(&id, KIND, &h))
}
