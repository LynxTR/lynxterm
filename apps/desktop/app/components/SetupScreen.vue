<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";

const emit = defineEmits<{ done: [] }>();
const onboarding = useOnboarding();
const sync = useSync();
const { hosts, refresh: refreshHosts } = useHosts();
const { refresh: refreshKeys } = useKeys();
const { ensure: ensureGroup, refresh: refreshGroups } = useGroups();
const toast = useToast();

const step = ref<"sync" | "hosts">("sync");

type ConfigHost = { name: string; host: string; port: number; user: string; identityFile: string };
const found = ref<ConfigHost[]>([]);
const picked = ref(new Set<string>());
const reviewing = ref(false);

const heading = computed((): [string, string] => {
  if (step.value === "sync" && !sync.url.value)
    return [
      "Sync on your own Cloudflare",
      "Keep the vault in sync across devices through a Worker on your Cloudflare account. One click creates the Worker and its D1 database; nothing else is needed.",
    ];
  if (step.value === "sync")
    return [
      "Connected",
      "This device is enrolled. Other devices join with the Worker URL and your master password; the token is not needed again.",
    ];
  if (reviewing.value)
    return [
      "Import from ~/.ssh/config",
      "Untick what you do not want. Keys named by IdentityFile go into the Keychain.",
    ];
  return [
    "Add your hosts",
    "Bring what you already have. Nothing is connected to until you say so.",
  ];
});
const intoGroup = ref(true);
const busy = ref(false);
// Code hosts answer SSH but are not login servers.
const notAServer = (h: ConfigHost) =>
  /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/.test(h.host);
const keyName = (path: string) => path.split("/").pop() || path;

watch(step, async (s) => {
  if (s !== "hosts") return;
  found.value = await invoke<ConfigHost[]>("ssh_config_hosts").catch(() => []);
  picked.value = new Set(found.value.filter((h) => !notAServer(h)).map((h) => h.name));
});
const keyFiles = computed(() => [
  ...new Set(
    found.value
      .filter((h) => picked.value.has(h.name) && h.identityFile)
      .map((h) => h.identityFile),
  ),
]);
function pick(name: string, on: boolean | "indeterminate") {
  if (on === true) picked.value.add(name);
  else picked.value.delete(name);
}

/** Keys imported without passphrase; keys needing one skipped, their hosts ask password. */
async function importHosts() {
  busy.value = true;
  try {
    const keyIds = new Map<string, string>();
    const failed: string[] = [];
    for (const path of keyFiles.value) {
      try {
        keyIds.set(
          path,
          await invoke<string>("key_import", { name: keyName(path), source: path, passphrase: "" }),
        );
      } catch {
        failed.push(keyName(path));
      }
    }
    if (intoGroup.value) await ensureGroup("Imported");
    for (const h of found.value.filter((h) => picked.value.has(h.name)))
      await hostSave({
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        keyId: keyIds.get(h.identityFile) ?? "",
        group: intoGroup.value ? "Imported" : "",
      });
    await Promise.all([refreshHosts(), refreshKeys(), refreshGroups()]);
    if (failed.length)
      toast.add({
        title: `${failed.length} ${failed.length === 1 ? "key needs" : "keys need"} a passphrase`,
        description: `${failed.join(", ")}: import from the Keychain. Their hosts ask for a password until then.`,
        color: "warning",
      });
    finish();
  } finally {
    busy.value = false;
  }
}

const typed = ref("");
const typedTarget = computed(() => parseTarget(typed.value));
async function addTyped() {
  if (!typedTarget.value) return;
  await hostSave({ ...typedTarget.value, name: "" });
  await refreshHosts();
  typed.value = "";
}

function finish() {
  onboarding.finish();
  emit("done");
}
</script>

<template>
  <OnboardingCard :step="step === 'sync' ? 2 : 3" :title="heading[0]" :text="heading[1]">
    <template v-if="step === 'sync' && !sync.url.value">
      <SyncConnect :password="onboarding.password()" />
      <div class="flex justify-end">
        <UButton
          label="Skip, this machine only"
          color="neutral"
          variant="link"
          size="xs"
          class="px-0"
          @click="step = 'hosts'"
        />
      </div>
    </template>

    <template v-else-if="step === 'sync'">
      <div class="flex flex-wrap gap-1.5">
        <UBadge :label="sync.host.value" class="font-mono" />
        <UBadge label="vault on D1" class="font-mono" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="t-label">What syncs, and how often</span>
        <SyncSections />
        <p class="text-xs text-muted">
          A check is one request for every section, as often as the fastest one, only while the app
          is in use. Change it any time in Settings -> Sync.
        </p>
      </div>
      <UButton label="Continue" size="lg" block @click="step = 'hosts'" />
    </template>

    <template v-else-if="reviewing">
      <ul
        class="flex max-h-72 flex-col overflow-y-auto rounded-xl border border-accented bg-default px-3.5"
      >
        <li
          v-for="h in found"
          :key="h.name"
          class="flex items-center gap-3 border-t border-default py-2 first:border-t-0"
        >
          <UCheckbox
            :model-value="picked.has(h.name)"
            :aria-label="`Import ${h.name}`"
            @update:model-value="pick(h.name, $event)"
          />
          <span
            class="min-w-0 flex-1 truncate font-mono text-xs"
            :class="notAServer(h) && 'text-muted'"
          >
            {{ h.name }}
          </span>
          <span class="truncate font-mono text-[11px] text-muted">
            {{ h.user }}@{{ h.host }}{{ h.port === 22 ? "" : `:${h.port}` }}
          </span>
          <UBadge
            :label="
              notAServer(h) ? 'not a server' : h.identityFile ? keyName(h.identityFile) : 'password'
            "
            size="sm"
            class="font-mono"
          />
        </li>
      </ul>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge :label="`${picked.size} selected`" class="font-mono" />
        <UBadge :label="`keys ${keyFiles.length}`" class="font-mono" />
        <UCheckbox
          v-model="intoGroup"
          label='Put them in a group named "Imported"'
          class="ml-auto"
        />
      </div>
      <UButton
        :label="`Import ${picked.size} ${picked.size === 1 ? 'host' : 'hosts'} and finish`"
        size="lg"
        block
        :disabled="!picked.size"
        :loading="busy"
        @click="importHosts"
      />
      <UButton
        label="Back"
        color="neutral"
        variant="link"
        size="xs"
        class="self-start px-0"
        @click="reviewing = false"
      />
    </template>

    <template v-else>
      <button
        v-if="found.length"
        class="flex items-center gap-3 rounded-lg border border-primary/60 bg-default px-3.5 py-3 text-left transition-colors hover:bg-elevated"
        @click="reviewing = true"
      >
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-toned"
        >
          <UIcon name="i-ph-file-text-duotone" class="size-4" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="font-mono text-sm font-semibold">~/.ssh/config</span>
          <span class="text-xs text-muted">
            {{ found.length }} {{ found.length === 1 ? "host" : "hosts" }} on this machine, with
            their users, ports and keys
          </span>
        </span>
        <UBadge :label="String(found.length)" class="font-mono" />
      </button>
      <form class="flex flex-col gap-2" @submit.prevent="addTyped">
        <span class="text-sm">Type one</span>
        <UFieldGroup class="w-full">
          <UInput
            v-model="typed"
            placeholder="user@host:port"
            aria-label="New host as user@host:port"
            class="flex-1"
            :ui="{ base: 'font-mono text-xs' }"
          />
          <UButton
            type="submit"
            label="Add"
            color="neutral"
            variant="outline"
            :disabled="!typedTarget"
          />
        </UFieldGroup>
        <div v-if="hosts.length" class="flex flex-wrap gap-1.5">
          <UBadge
            v-for="h in hosts"
            :key="h.id"
            :label="hostLabel(h)"
            size="sm"
            class="font-mono"
          />
        </div>
      </form>
      <UButton
        :label="hosts.length ? 'Finish' : 'Skip, start empty'"
        size="lg"
        block
        :color="hosts.length ? 'primary' : 'neutral'"
        :variant="hosts.length ? 'solid' : 'outline'"
        @click="finish"
      />
      <p class="text-center text-xs text-muted">
        You land on Hosts. Watch a host there to start monitoring it.
      </p>
    </template>
  </OnboardingCard>
</template>
