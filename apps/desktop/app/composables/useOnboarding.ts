import { invoke } from "@tauri-apps/api/core";

// First run after vault creation: sync and hosts steps (SetupScreen) before app opens. Master
// password kept here, memory only, so sync doesn't ask again; finish() drops it.
const firstRun = ref(false);
let password = "";

/** vault-worker folder for Cloudflare Deploy button. Change if forked. */
export const WORKER_REPO = "https://github.com/LynxTR/lynxterm/tree/main/apps/vault-worker";
export const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${WORKER_REPO}`;

/** Default browser. Only sites open_external allows (onboarding.rs). */
export const openExternal = (url: string) =>
  invoke("open_external", { url }).catch(() => window.open(url, "_blank"));

/** 24 random bytes, base64url. */
export function newEnrollToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
