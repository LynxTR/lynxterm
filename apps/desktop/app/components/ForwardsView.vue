<script setup lang="ts">
const { forwards, running, save, remove, start, stop } = useForwards();
const { hosts } = useHosts();

const hostOf = (f: Forward) => hosts.value.find((h) => h.id === f.hostId);
const hostItems = computed(() =>
  hosts.value.map((h) => ({ label: hostName(h), description: hostLabel(h), value: h.id! })),
);
const title = (f: Forward) => f.name || `Port ${f.localPort}`;
const route = (f: Forward) =>
  `localhost:${f.localPort} -> ${maskHost(f.remoteHost)}:${f.remotePort}`;

const { filter, shown } = useFilter(
  () => forwards.value,
  (f) => `${title(f)} ${f.remoteHost} ${f.localPort} ${hostOf(f) ? hostName(hostOf(f)!) : ""}`,
);
const { draft, submit } = useDraft(forwards, save, "Forward saved");
const isRunning = computed(() => !!draft.value?.id && running.value.includes(draft.value.id));
const draftHost = computed(() => (draft.value ? hostOf(draft.value) : undefined));
/** Per tunnel end: label, address, protocol of hop into it. */
const path = computed(() => [
  ["This machine", `localhost:${draft.value?.localPort}`, ""],
  ["Through", draftHost.value ? hostLabel(draftHost.value) : "No host", "ssh"],
  ["Reaches", `${maskHost(draft.value?.remoteHost ?? "")}:${draft.value?.remotePort}`, "tcp"],
]);
const saved = computed(() => forwards.value.find((f) => f.id === draft.value?.id));
const edited = computed(
  () => !!saved.value && JSON.stringify(saved.value) !== JSON.stringify(draft.value),
);

function newForward() {
  draft.value = {
    name: "",
    hostId: hosts.value[0]?.id ?? "",
    localPort: 8080,
    remoteHost: "127.0.0.1",
    remotePort: 80,
  };
}

const busy = ref(false);

const asking = ref(false);
const password = ref("");
function toggle() {
  const id = draft.value!.id!;
  if (isRunning.value) return withBusy(busy, () => stop(id));
  if (draftHost.value?.keyId) return withBusy(busy, () => start(id));
  password.value = "";
  asking.value = true;
}
function startWithPassword() {
  asking.value = false;
  const id = draft.value!.id!;
  withBusy(busy, () => start(id, password.value));
}

async function forget() {
  const f = draft.value!;
  const ok = await askConfirm({
    title: `Delete ${title(f)}?`,
    description: isRunning.value
      ? "Stops the tunnel and removes the forward from your vault on every device."
      : "Removes the forward from your vault on every device.",
    detail: route(f),
  });
  if (!ok) return;
  draft.value = null;
  await remove(f.id!);
}
</script>

<template>
  <div class="flex min-h-0">
    <ListColumn
      v-model:filter="filter"
      title="Port forwarding"
      :count="forwards.length"
      :empty="!shown.length"
    >
      <template #actions>
        <UButton
          icon="i-ph-plus"
          label="New"
          aria-label="New forward"
          size="sm"
          :disabled="!hosts.length"
          @click="newForward"
        />
      </template>
      <ListRow
        v-for="f in shown"
        :key="f.id"
        :title="title(f)"
        :subtitle="route(f)"
        :selected="draft?.id === f.id"
        @select="draft = { ...f }"
      >
        <HostChip v-if="hostOf(f)" :label="hostName(hostOf(f)!)" :group="hostOf(f)!.group" />
        <UBadge
          :label="running.includes(f.id!) ? 'running' : 'stopped'"
          :variant="running.includes(f.id!) ? 'soft' : 'outline'"
          size="sm"
        />
      </ListRow>
      <template #empty>
        <EmptyState
          icon="i-ph-arrows-left-right"
          :filtered="!!forwards.length"
          title="No forwards yet"
          :text="
            hosts.length
              ? 'Reach a database or dashboard behind a server as if it ran on this machine.'
              : 'Save a host first; forwards run through one.'
          "
        />
      </template>
    </ListColumn>

    <main v-if="draft" class="pane max-w-[760px]">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-xl font-semibold">{{ draft.id ? title(draft) : "New forward" }}</h2>
        <UBadge
          v-if="draft.id"
          :label="isRunning ? 'running' : 'stopped'"
          :variant="isRunning ? 'soft' : 'outline'"
        />
        <UBadge v-if="isRunning && edited" label="restart to apply" />
        <div v-if="draft.id" class="ml-auto flex flex-wrap gap-2">
          <UButton
            :label="isRunning ? 'Stop' : 'Start'"
            :icon="isRunning ? 'i-ph-square' : 'i-ph-play-duotone'"
            :color="isRunning ? 'neutral' : 'primary'"
            :variant="isRunning ? 'outline' : 'solid'"
            :loading="busy"
            :disabled="!draftHost"
            @click="toggle"
          />
          <UButton label="Delete" color="neutral" variant="ghost" @click="forget" />
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-center gap-3 card p-5">
        <template v-for="([label, at, via], i) in path" :key="label">
          <span v-if="i" class="flex items-center gap-1.5 text-[11px] text-dimmed">
            {{ via }} <UIcon name="i-ph-arrow-right" class="size-4" />
          </span>
          <div
            class="flex min-w-40 flex-col items-center gap-1 rounded-md border border-accented bg-default px-4 py-3 text-center"
          >
            <span class="text-[11px] text-dimmed">{{ label }}</span>
            <span class="truncate font-mono text-xs">{{ at }}</span>
          </div>
        </template>
        <p class="w-full text-center text-xs text-muted">
          Connect your local client to
          <span class="font-mono">localhost:{{ draft.localPort }}</span
          >. Traffic goes over SSH to the host, then to the remote address from there. Listens on
          127.0.0.1 only.
        </p>
      </div>

      <form class="flex max-w-3xl flex-col gap-4 card p-4" @submit.prevent="submit">
        <div class="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-4">
          <UFormField label="Name" hint="Optional">
            <UInput v-model="draft.name" placeholder="Postgres on db-primary" class="w-full" />
          </UFormField>
          <UFormField label="Host">
            <USelect v-model="draft.hostId" :items="hostItems" class="w-full" />
          </UFormField>
        </div>
        <div class="grid grid-cols-[110px_minmax(0,1fr)_110px] items-end gap-3">
          <UFormField label="Local port">
            <UInput
              v-model.number="draft.localPort"
              type="number"
              min="1"
              max="65535"
              required
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="Remote host">
            <UInput v-model="draft.remoteHost" required class="w-full font-mono" />
          </UFormField>
          <UFormField label="Remote port">
            <UInput
              v-model.number="draft.remotePort"
              type="number"
              min="1"
              max="65535"
              required
              class="w-full font-mono"
            />
          </UFormField>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs text-dimmed">Edits apply on the next start.</span>
          <UButton type="submit" label="Save" class="ml-auto" />
        </div>
      </form>
    </main>

    <EmptyLogo v-else />

    <UModal v-model:open="asking" title="Password for the tunnel's host">
      <template #body>
        <form id="forward-password" @submit.prevent="startWithPassword">
          <UInput v-model="password" type="password" autofocus required class="w-full" />
        </form>
      </template>
      <template #footer>
        <UButton type="submit" form="forward-password" label="Start" icon="i-ph-play-duotone" />
      </template>
    </UModal>
  </div>
</template>
