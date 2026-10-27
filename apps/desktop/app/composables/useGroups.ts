import { invoke } from "@tauri-apps/api/core";

interface Group {
  id?: string;
  name: string;
  color: string;
  /** Drag position from Settings; missing on groups saved before ordering. */
  order?: number;
}

export const GROUP_COLORS = [
  { hex: "#ffb020", name: "Amber" },
  { hex: "#fb923c", name: "Orange" },
  { hex: "#ff8a8a", name: "Red" },
  { hex: "#f472b6", name: "Pink" },
  { hex: "#a78bfa", name: "Violet" },
  { hex: "#6cb6ff", name: "Blue" },
  { hex: "#2dd4bf", name: "Teal" },
  { hex: "#3ddc97", name: "Green" },
  { hex: "#a3abb7", name: "Gray" },
];

const groups = ref<Group[]>([]);

const byName = (name?: string) => groups.value.find((g) => g.name === name);

/** "" for no group or no color. */
export const groupColor = (name?: string) => byName(name)?.color ?? "";

/** Names in Settings order (then by name), plus names hosts use without saved group. */
const names = computed(() => {
  const saved = [...groups.value]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
    .map((g) => g.name);
  const orphans = useHosts()
    .hosts.value.map((h) => h.group)
    .filter((g): g is string => !!g && !saved.includes(g));
  return [...saved, ...new Set(orphans)];
});

const tags = computed(() => {
  const count = new Map<string, number>();
  for (const h of useHosts().hosts.value)
    for (const t of h.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count]
    .map(([name, hosts]) => ({ name, hosts }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

async function editHosts(
  match: (h: SavedHost) => boolean,
  change: (h: SavedHost) => Partial<SavedHost>,
) {
  const { hosts, refresh } = useHosts();
  for (const h of hosts.value.filter(match)) await hostSave({ ...h, ...change(h) });
  await refresh();
}

export function useGroups() {
  const refresh = async () => {
    groups.value = await invoke<Group[]>("groups_list");
  };

  const save = (group: Group) => invoke("group_save", { group }).then(refresh);

  const ensure = async (name: string) => {
    if (!name || byName(name)) return;
    const used = new Set(groups.value.map((g) => g.color));
    const color = (GROUP_COLORS.find((c) => !used.has(c.hex)) ?? GROUP_COLORS[0]!).hex;
    const order = Math.max(-1, ...groups.value.map((g) => g.order ?? 0)) + 1;
    await save({ name, color, order });
  };

  const setColor = async (name: string, color: string) => {
    await save({ ...(byName(name) ?? { name }), color });
  };

  /** Moves hosts too; renaming onto existing group merges. */
  const rename = async (from: string, to: string) => {
    to = to.trim();
    if (!to || to === from) return;
    await editHosts(
      (h) => h.group === from,
      () => ({ group: to }),
    );
    const old = byName(from);
    if (old && byName(to)) await invoke("item_delete", { id: old.id });
    else if (old) await invoke("group_save", { group: { ...old, name: to } });
    await refresh();
  };

  /** Hosts stay, ungrouped. */
  const remove = async (name: string) => {
    await editHosts(
      (h) => h.group === name,
      () => ({ group: "" }),
    );
    const group = byName(name);
    if (group) await invoke("item_delete", { id: group.id });
    await refresh();
  };

  /** Saves only groups whose position changed. Names only hosts use get saved too. */
  const move = async (name: string, to: number) => {
    const list = names.value.filter((n) => n !== name);
    list.splice(to, 0, name);
    for (const [order, n] of list.entries()) {
      const g = byName(n);
      if (g?.order !== order)
        await invoke("group_save", { group: { ...(g ?? { name: n, color: "" }), order } });
    }
    await refresh();
  };

  /** Renaming onto existing tag merges. */
  const renameTag = async (from: string, to: string) => {
    to = normalizeTag(to);
    if (!to || to === from) return;
    await editHosts(
      (h) => !!h.tags?.includes(from),
      (h) => ({ tags: h.tags!.map((t) => (t === from ? to : t)) }),
    );
  };

  const removeTag = (tag: string) =>
    editHosts(
      (h) => !!h.tags?.includes(tag),
      (h) => ({ tags: h.tags!.filter((t) => t !== tag) }),
    );

  return {
    names,
    tags,
    refresh,
    ensure,
    setColor,
    rename,
    remove,
    move,
    renameTag,
    removeTag,
  };
}
