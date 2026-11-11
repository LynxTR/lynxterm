import { invoke } from "@tauri-apps/api/core";
import type { SshTarget } from "~/components/SshTerminal.vue";

export type SavedHost = Omit<SshTarget, "password"> & {
  id?: string;
  group?: string;
  os?: string;
  tags?: string[];
  /** Password in vault; value only via host_password_reveal. */
  savedPassword?: boolean;
};

export const asksPassword = (h: { keyId: string; savedPassword?: boolean }) =>
  !h.keyId && !h.savedPassword;

export const normalizeTag = (t: string) =>
  t
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]/g, "");

export const hostName = (h: { name?: string; host: string }) => h.name || maskHost(h.host);

/** Never masked: hosts can look alike once addresses hidden. */
export const hostKey = (h: { user: string; host: string; port: number }) =>
  `${h.user}@${h.host}:${h.port}`;

const hosts = ref<SavedHost[]>([]);
export const hostItems = computed(() =>
  hosts.value.map((h) => ({ label: hostName(h), description: hostLabel(h), value: h.id! })),
);
export const savedHost = (h: { user: string; host: string; port: number }) =>
  hosts.value.find((x) => hostKey(x) === hostKey(h));

export const hostLabel = (h: { user: string; host: string; port: number }, mask = true) =>
  `${h.user}@${mask ? maskHost(h.host) : h.host}${h.port === 22 ? "" : `:${h.port}`}`;

export function parseTarget(text: string) {
  const m = text.trim().match(/^(?:ssh\s+)?([^\s@]+)@([^\s@:]+)(?::(\d{1,5}))?$/);
  return m ? { user: m[1]!, host: m[2]!, port: Number(m[3] ?? 22), keyId: "" } : null;
}

// Explicit fields: password only via host_password_save.
export const hostSave = ({ id, name, group, host, port, user, keyId, os, tags }: SavedHost) =>
  invoke("host_save", {
    host: {
      id,
      name,
      group: group || "",
      host,
      port,
      user,
      keyId,
      os: os || "",
      tags: [...new Set((tags ?? []).map(normalizeTag).filter(Boolean))],
    },
  });

export function useHosts() {
  const refresh = async () => {
    hosts.value = await invoke<SavedHost[]>("hosts_list");
  };

  const save = async (h: SavedHost) => {
    const id = savedHost(h)?.id;
    await hostSave({ ...h, id });
    await refresh();
  };

  const remove = (h: SavedHost) => invoke("item_delete", { id: h.id }).then(refresh);

  return { hosts, refresh, save, remove };
}
