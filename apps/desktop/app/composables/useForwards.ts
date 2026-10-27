import { invoke } from "@tauri-apps/api/core";

export interface Forward {
  id?: string;
  name: string;
  hostId: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

const forwards = ref<Forward[]>([]);
const running = ref<string[]>([]);

export function useForwards() {
  const refresh = async () => {
    [forwards.value, running.value] = await Promise.all([
      invoke<Forward[]>("forwards_list"),
      invoke<string[]>("forwards_running"),
    ]);
    forwards.value.sort((a, b) => a.localPort - b.localPort);
  };
  /** Resolves to id; new one for new forward. */
  const save = (forward: Forward) =>
    invoke<string>("forward_save", { forward }).then((id) => refresh().then(() => id));
  const remove = (id: string) => invoke("forward_delete", { id }).then(refresh);
  const start = (id: string, password = "") =>
    invoke("forward_start", { id, password }).then(refresh);
  const stop = (id: string) => invoke("forward_stop", { id }).then(refresh);
  return { forwards, running, refresh, save, remove, start, stop };
}
