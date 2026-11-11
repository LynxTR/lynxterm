<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";

const settings = useSettings();
const { hosts } = useHosts();
const history = useHistory();
const toast = useToast();

const installed = (h: SavedHost) => settings.integratedHosts.includes(hostKey(h));

// Password asked inline, not kept.
const asking = ref<{ id: string; remove: boolean } | null>(null);
const password = ref("");
const busy = ref("");

async function integrate(h: SavedHost, remove: boolean) {
  if (asksPassword(h) && asking.value?.id !== h.id) {
    asking.value = { id: h.id!, remove };
    password.value = "";
    return;
  }
  busy.value = h.id!;
  try {
    await invoke("shell_integration_host", { hostId: h.id, password: password.value, remove });
    setIn("integratedHosts", hostKey(h), !remove);
    logActivity(h, {
      kind: "integration",
      title: remove ? "Removed shell integration" : "Installed shell integration",
      detail: "~/.bashrc, ~/.zshrc",
    });
    asking.value = null;
    toast.add({
      title: remove ? `Removed from ${hostName(h)}` : `Installed on ${hostName(h)}`,
      description: remove
        ? "New terminals there go back to normal."
        : "Takes effect in new terminals.",
      icon: "i-ph-check",
    });
  } catch (e) {
    toast.add({ title: `Could not change ${hostName(h)}`, description: String(e), color: "error" });
    logActivity(h, {
      kind: "integration",
      title: `Shell integration ${remove ? "removal" : "install"} failed`,
      detail: String(e),
      ok: false,
    });
  } finally {
    busy.value = "";
    password.value = "";
  }
}

const entries = computed(() =>
  [...history.byHost].map(([key, commands]) => {
    const saved = hosts.value.find((h) => hostKey(h) === key);
    const [, user = "", host = key, port = "22"] = key.match(/^(.*)@(.*):(\d+)$/) ?? [];
    const label = hostLabel({ user, host, port: Number(port) });
    return { key, commands, name: saved ? hostName(saved) : maskHost(host), label };
  }),
);
const total = computed(() => entries.value.reduce((n, e) => n + e.commands.length, 0));
const open = ref("");

async function purge(key: string, name = "") {
  const ok = await askConfirm({
    title: key ? `Purge history for ${name}?` : "Purge all command history?",
    description: "Removes the saved commands here and on your synced devices.",
    label: "Purge",
  });
  if (!ok) return;
  if (open.value === key || !key) open.value = "";
  await history.purge(key || undefined);
  toast.add({
    title: key ? "History purged for this host" : "All history purged",
    icon: "i-ph-check",
  });
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <h2 class="t-title">Terminal</h2>

    <div class="box gap-4 p-4">
      <USwitch
        v-model="settings.history"
        label="Learn from command history"
        description="Commands you run feed the grey → suggestions, per host. Stored encrypted in your vault and synced. Lines starting with a space and password prompts are never saved."
      />
      <USwitch
        v-model="settings.setupLine"
        label="Type a setup line into new sessions"
        description="A short hidden line in each new bash or zsh session, once it sees a shell prompt, never at a password or other login question, so suggestions read exactly what you typed. Nothing is saved on the server. Off: suggestions follow only what you type. Applies to new terminals."
      />
      <USwitch
        v-model="settings.localEcho"
        label="Show typing before the server answers"
        description="On a slow connection, what you type appears grey right away and turns normal once the server echoes it. Never at password prompts or in full-screen apps like vim."
      />
    </div>

    <div class="box">
      <div class="flex flex-col gap-1.5 border-b border-default p-4">
        <h3 class="t-section">Shell integration</h3>
        <p class="text-sm text-muted">
          Adds a small block to <code class="font-mono text-xs">~/.bashrc</code> and
          <code class="font-mono text-xs">~/.zshrc</code> on the server. It marks where your prompt
          ends, so suggestions read exactly what you typed. Nothing else changes; Remove takes it
          out again.
        </p>
      </div>
      <ul class="divide-y divide-default">
        <li
          v-for="h in hosts"
          :key="h.id"
          class="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2"
        >
          <span
            class="size-2.5 shrink-0 rounded-full"
            :class="installed(h) ? 'bg-success' : 'bg-accented'"
          />
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate font-medium">{{ hostName(h) }}</span>
            <span class="truncate font-mono text-xs text-muted">{{ hostLabel(h) }}</span>
          </div>

          <form
            v-if="asking?.id === h.id"
            class="flex min-w-0 basis-full gap-2 sm:basis-auto"
            @submit.prevent="integrate(h, !!asking?.remove)"
          >
            <UInput
              v-model="password"
              type="password"
              size="sm"
              required
              autofocus
              :placeholder="`Password for ${h.user}`"
              aria-label="SSH password"
              class="min-w-0 flex-1 sm:w-48"
            />
            <UButton
              color="primary"
              type="submit"
              size="sm"
              :label="asking?.remove ? 'Remove' : 'Install'"
              :loading="busy === h.id"
            />
            <UButton label="Cancel" size="sm" variant="ghost" @click="asking = null" />
          </form>
          <template v-else-if="installed(h)">
            <UBadge label="Installed" color="success" variant="subtle" />
            <UButton
              label="Remove"
              size="sm"
              variant="outline"
              :loading="busy === h.id"
              @click="integrate(h, true)"
            />
          </template>
          <UButton
            v-else
            label="Install"
            icon="i-ph-download-simple-duotone"
            size="sm"
            variant="outline"
            :loading="busy === h.id"
            @click="integrate(h, false)"
          />
        </li>
        <li v-if="!hosts.length" class="px-4 py-3 text-sm text-muted">No saved hosts yet.</li>
      </ul>
    </div>

    <div class="box">
      <div class="flex flex-wrap items-center gap-3 border-b border-default p-4">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 class="t-section">Command history</h3>
          <p class="text-sm text-muted">
            {{ total }} {{ total === 1 ? "command" : "commands" }} across {{ entries.length }}
            {{ entries.length === 1 ? "host" : "hosts" }}
            <template v-if="!settings.history">. Not learning new ones.</template>
          </p>
        </div>
        <UButton
          v-if="entries.length"
          icon="i-ph-trash-duotone"
          label="Purge all"
          color="error"
          variant="outline"
          size="sm"
          @click="purge('')"
        />
      </div>
      <ul class="divide-y divide-default">
        <li v-for="e in entries" :key="e.key">
          <div class="flex min-h-14 items-center gap-3 px-4 py-2">
            <UButton
              :icon="open === e.key ? 'i-ph-caret-down' : 'i-ph-caret-right'"
              size="xs"
              variant="ghost"
              :aria-label="`${open === e.key ? 'Hide' : 'Show'} history for ${e.name}`"
              :aria-expanded="open === e.key"
              @click="open = open === e.key ? '' : e.key"
            />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium">{{ e.name }}</span>
              <span class="truncate font-mono text-xs text-muted">{{ e.label }}</span>
            </div>
            <span class="font-mono text-xs text-muted">{{ e.commands.length }}</span>
            <UButton
              icon="i-ph-trash-duotone"
              size="xs"
              color="error"
              variant="ghost"
              :aria-label="`Purge history for ${e.name}`"
              @click="purge(e.key, e.name)"
            />
          </div>
          <ol
            v-if="open === e.key"
            class="max-h-64 overflow-y-auto border-t border-default bg-sunken px-4 py-2 font-mono text-xs"
          >
            <li v-for="(c, i) in e.commands.toReversed()" :key="i" class="truncate py-1" :title="c">
              {{ c }}
            </li>
          </ol>
        </li>
        <li v-if="!entries.length" class="px-4 py-3 text-sm text-muted">
          {{
            settings.history ? "Nothing yet. Run some commands in a terminal." : "Nothing saved."
          }}
        </li>
      </ul>
    </div>

    <p class="hint">
      <UIcon name="i-ph-info-duotone" class="size-[18px]" />
      Purging syncs to every device. Installed status is what this device has seen.
    </p>
  </div>
</template>
