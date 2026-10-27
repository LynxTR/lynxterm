//! Per-host log of what Lynxterm did (snippets run, keys installed, files moved…).
//! In vault like command history: encrypted, synced.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::vault::{Open, Vault, new_id};

const KIND: &str = "activity";
const MAX_ENTRIES: usize = 500;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Unix seconds.
    at: u64,
    /// snippet, key, upload, download, monitoring, integration…
    kind: String,
    title: String,
    detail: String,
    ok: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    /// user@host:port: unsaved hosts get log too.
    host_key: String,
    entries: Vec<Entry>,
}

/// Host's entries, oldest first. Sync conflict can leave twin items per host: entries
/// merged here, items folded into one on next log.
fn entries(v: &Open, host_key: &str) -> Result<(Vec<String>, Vec<Entry>), String> {
    let (mut ids, mut all) = (Vec::new(), Vec::new());
    for (id, a) in v.list::<Activity>(KIND)? {
        if a.host_key == host_key {
            ids.push(id);
            all.extend(a.entries);
        }
    }
    all.sort_by_key(|e| e.at);
    all.dedup_by(|a, b| a.at == b.at && a.kind == b.kind && a.title == b.title);
    Ok((ids, all))
}

#[tauri::command]
pub fn activity_list(vault: State<'_, Vault>, host_key: String) -> Result<Vec<Entry>, String> {
    vault.with(|v| entries(v, &host_key).map(|(_, e)| e))
}

#[tauri::command]
pub fn activity_log(vault: State<'_, Vault>, host_key: String, entry: Entry) -> Result<(), String> {
    vault.with(|v| {
        let (ids, mut all) = entries(v, &host_key)?;
        all.push(entry);
        let excess = all.len().saturating_sub(MAX_ENTRIES);
        all.drain(..excess);
        let id = ids.first().cloned().unwrap_or_else(new_id);
        for twin in ids.iter().skip(1) {
            v.delete(twin)?;
        }
        v.put(
            &id,
            KIND,
            &Activity {
                host_key,
                entries: all,
            },
        )
    })
}
