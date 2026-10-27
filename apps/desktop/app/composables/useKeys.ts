import { invoke } from "@tauri-apps/api/core";

interface SshKey {
  id: string;
  name: string;
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  createdAt: number; // unix seconds, 0 if unknown
  origin: "generated" | "imported" | "";
  rev: number; // server revision; 0 = never synced
  dirty: boolean; // changed since last sync
}

const keys = ref<SshKey[]>([]);

export const keyAlgorithm = (a: string) => a.replace(/^ssh-/, "").toUpperCase();

export function useKeys() {
  const refresh = async () => {
    keys.value = await invoke<SshKey[]>("keys_list");
  };
  return { keys, refresh };
}
