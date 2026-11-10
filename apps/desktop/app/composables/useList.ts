import { invoke } from "@tauri-apps/api/core";
import type { Ref } from "vue";

export function useFilter<T>(list: () => T[], text: (item: T) => string) {
  const filter = ref("");
  const shown = computed(() => {
    const q = filter.value.trim().toLowerCase();
    return q ? list().filter((x) => text(x).toLowerCase().includes(q)) : list();
  });
  return { filter, shown };
}

export function vaultList<T extends { name: string }>(list: Ref<T[]>, kind: string) {
  const refresh = async () => {
    list.value = (await invoke<T[]>(`${kind}s_list`)).sort((a, b) => a.name.localeCompare(b.name));
  };
  const save = (item: T) =>
    invoke<string>(`${kind}_save`, { [kind]: item }).then((id) => refresh().then(() => id));
  const remove = (id: string) => invoke("item_delete", { id }).then(refresh);
  return { refresh, save, remove };
}

/** Deep copy: nested fields (tags, service functions) edited in draft must not change list
 *  before save. */
export function useDraft<T extends { id?: string }>(
  list: Ref<T[]>,
  save: (item: T) => Promise<string>,
  saved: string,
) {
  const draft = ref(null) as Ref<T | null>;
  watch(
    list,
    (items) => {
      if (!draft.value || (draft.value.id && !items.some((x) => x.id === draft.value!.id)))
        draft.value = items[0] ? structuredClone(toRaw(items[0])) : null;
    },
    { immediate: true },
  );
  async function submit() {
    const id = await save(draft.value!);
    draft.value = { ...draft.value!, id };
    useToast().add({ title: saved, icon: "i-ph-check" });
  }
  return { draft, submit };
}
