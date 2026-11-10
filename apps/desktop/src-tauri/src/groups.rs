//! Hosts refer to group by name.

use serde::{Deserialize, Serialize};

const KIND: &str = "group";

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Group {
    id: String,
    name: String,
    color: String,
    order: i64,
}

crate::kind_commands!(groups_list, group_save(group): Group, KIND);
