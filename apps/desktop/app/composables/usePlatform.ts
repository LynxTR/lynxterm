import type { Ref } from "vue";

/** macOS draws own traffic lights over header; elsewhere app draws controls. */
export const isMac = navigator.userAgent.includes("Mac");

export async function copyText(text: string, title = "Copied", description?: string) {
  try {
    await navigator.clipboard.writeText(text);
    useToast().add({ title, description, icon: "i-ph-check" });
  } catch (e) {
    useToast().add({ title: "Could not copy", description: String(e), color: "error" });
  }
}

export async function withBusy(busy: Ref<boolean>, fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    useToast().add({ title: String(e), color: "error" });
  } finally {
    busy.value = false;
  }
}
