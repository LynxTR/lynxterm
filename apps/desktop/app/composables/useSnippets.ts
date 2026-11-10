export interface Snippet {
  id?: string;
  name: string;
  command: string;
}

const snippets = ref<Snippet[]>([]);

export const useSnippets = () => ({ snippets, ...vaultList(snippets, "snippet") });
