//! Host groups. Hosts refer to group by name.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::vault::{Vault, new_id};

const KIND: &str = "group";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default)]
    color: String,
    /// Position among groups; ties sort by name.
    #[serde(default)]
    order: i64,
}

#[tauri::command]
pub fn groups_list(vault: State<'_, Vault>) -> Result<Vec<Group>, String> {
    let groups = vault.with(|v| v.list::<Group>(KIND))?;
    Ok(groups
        .into_iter()
        .map(|(id, g)| Group { id, ..g })
        .collect())
}

#[tauri::command]
pub fn group_save(vault: State<'_, Vault>, mut group: Group) -> Result<(), String> {
    if group.id.is_empty() {
        group.id = new_id();
    }
    vault.with(|v| v.put(&group.id, KIND, &group))
}
