import { invoke } from "@tauri-apps/api/core";

// Master password kept here, memory only, so sync doesn't ask again; finish() drops it.
const firstRun = ref(false);
let password = "";

export const WORKER_REPO = "https://github.com/LynxTR/lynxterm/tree/main/apps/vault-worker";
export const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${WORKER_REPO}`;

/** Only sites open_external allows (onboarding.rs). */
export const openExternal = (url: string) =>
  invoke("open_external", { url }).catch(() => window.open(url, "_blank"));

export function newEnrollToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export const useOnboarding = () => ({
  firstRun,
  start(pw: string) {
    password = pw;
    firstRun.value = true;
  },
  password: () => password,
  finish() {
    password = "";
    firstRun.value = false;
  },
});
