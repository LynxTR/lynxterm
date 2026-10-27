import { invoke } from "@tauri-apps/api/core";

export interface KnownHost {
  line: number;
  hosts: string; // empty when OpenSSH hashed names
  algorithm: string;
  fingerprint: string;
}

const knownHosts = ref<KnownHost[]>([]);

export function useKnownHosts() {
  const refresh = async () => {
    knownHosts.value = await invoke<KnownHost[]>("known_hosts_list");
  };
  const remove = (h: KnownHost) =>
    invoke("known_host_delete", { line: h.line, fingerprint: h.fingerprint }).then(refresh);
  return { knownHosts, refresh, remove };
}
