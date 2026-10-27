use serde::{Deserialize, Serialize};
use tauri::State;

use crate::vault::{Vault, new_id};

const KIND: &str = "snippet";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default)]
    id: String,
    name: String,
    command: String,
}

#[tauri::command]
pub fn snippets_list(vault: State<'_, Vault>) -> Result<Vec<Snippet>, String> {
    let snippets = vault.with(|v| v.list::<Snippet>(KIND))?;
    Ok(snippets
        .into_iter()
        .map(|(id, s)| Snippet { id, ..s })
        .collect())
}

#[tauri::command]
/// Returns id, generated if new.
pub fn snippet_save(vault: State<'_, Vault>, mut snippet: Snippet) -> Result<String, String> {
    if snippet.id.is_empty() {
        snippet.id = new_id();
    }
    vault.with(|v| v.put(&snippet.id, KIND, &snippet))?;
    Ok(snippet.id)
}
