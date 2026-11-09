use serde::{Deserialize, Serialize};

const KIND: &str = "snippet";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default)]
    id: String,
    name: String,
    command: String,
}

crate::kind_commands!(snippets_list, snippet_save(snippet): Snippet, KIND);
