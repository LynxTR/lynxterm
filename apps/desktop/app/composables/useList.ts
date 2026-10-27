import type { Ref } from "vue";

export function useFilter<T>(list: () => T[], text: (item: T) => string) {
  const filter = ref("");
  const shown = computed(() => {
    const q = filter.value.trim().toLowerCase();
    return q ? list().filter((x) => text(x).toLowerCase().includes(q)) : list();
  });
  return { filter, shown };
}

/** Detail pane's copy of an item: first one until another picked, and after delete. New item:
 *  draft without id. `submit` saves, keeps id, toasts `saved`. */
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
        draft.value = items[0] ? { ...items[0] } : null;
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
