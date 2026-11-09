//! Host groups. Hosts refer to group by name.

use serde::{Deserialize, Serialize};

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

crate::kind_commands!(groups_list, group_save(group): Group, KIND);
