import { invoke } from "@tauri-apps/api/core";

export type Activity = {
  at: number; // unix seconds
  kind: "snippet" | "key" | "upload" | "download" | "monitoring" | "integration" | "service";
  title: string;
  detail?: string;
  ok?: boolean;
};

export const activityVersion = ref(0);

/** Never throws: missed log line must not break action. */
export function logActivity(
  target: { user: string; host: string; port: number },
  entry: Omit<Activity, "at">,
) {
  return invoke("activity_log", {
    hostKey: hostKey(target),
    entry: { at: Math.floor(Date.now() / 1000), detail: "", ok: true, ...entry },
  })
    .then(() => activityVersion.value++)
    .catch(() => {});
}
