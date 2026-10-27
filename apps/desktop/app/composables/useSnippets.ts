import { invoke } from "@tauri-apps/api/core";

export interface Snippet {
  id?: string;
  name: string;
  command: string;
}

const snippets = ref<Snippet[]>([]);

export function useSnippets() {
  const refresh = async () => {
    snippets.value = (await invoke<Snippet[]>("snippets_list")).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  };
  /** Resolves to id; new one for new snippet. */
  const save = (snippet: Snippet) =>
    invoke<string>("snippet_save", { snippet }).then((id) => refresh().then(() => id));
  const remove = (id: string) => invoke("item_delete", { id }).then(refresh);
  return { snippets, refresh, save, remove };
}
