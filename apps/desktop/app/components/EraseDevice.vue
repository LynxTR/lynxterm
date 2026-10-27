<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";

// Wrong master password changes nothing.
const open = ref(false);
const password = ref("");
const error = ref("");
const busy = ref(false);

function ask() {
  password.value = "";
  error.value = "";
  open.value = true;
}

async function erase() {
  busy.value = true;
  error.value = "";
  try {
    await invoke("vault_erase", { password: password.value });
  } catch (e) {
    error.value = String(e);
    busy.value = false;
    return;
  }
  // Settings and layout live in webview storage, outside vault.
  try {
    localStorage.clear();
  } catch {
    // storage blocked: nothing to clear
  }
  // Restart ends sessions and tunnels opened with old vault.
  await invoke("app_restart").catch(() => location.reload());
}
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-3 rounded-[10px] border border-error/30 bg-sunken p-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex min-w-60 flex-1 flex-col gap-1">
        <span class="font-medium">Erase this device</span>
        <span class="text-sm text-muted">
          Removes your hosts, keys, snippets, history and settings from this computer and starts
          Lynxterm over at first run.
        </span>
      </div>
      <UButton label="Erase this device…" color="error" variant="outline" @click="ask" />
    </div>
  </div>

  <UModal v-model:open="open" title="Erase this device?">
    <template #body>
      <form id="erase-form" class="flex flex-col gap-4" @submit.prevent="erase">
        <ul class="flex list-disc flex-col gap-1.5 pl-5 text-sm text-toned">
          <li>The vault on this computer is deleted, with every host, key, snippet and log.</li>
          <li>The key remembered in your system keyring is removed.</li>
          <li>
            Your Cloudflare Worker keeps its encrypted copy. Join it again later with your master
            password.
          </li>
          <li>Servers keep the history files Lynxterm saved on them.</li>
        </ul>
        <UFormField label="Master password" :error="error || undefined">
          <UInput v-model="password" type="password" required autofocus class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          type="submit"
          form="erase-form"
          label="Erase and start over"
          color="error"
          :loading="busy"
          :disabled="!password"
        />
      </div>
    </template>
  </UModal>
</template>
