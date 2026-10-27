<script setup lang="ts">
const settings = useSettings();
const m = settings.monitoring;
const { hosts } = useHosts();

const showAll = ref(false);
const listed = computed(() => {
  const sorted = hosts.value.toSorted(
    (a, b) => Number(isWatched(b)) - Number(isWatched(a)) || hostName(a).localeCompare(hostName(b)),
  );
  return showAll.value ? sorted : sorted.slice(0, 6);
});
const watchedCount = computed(() => hosts.value.filter(isWatched).length);

const overrideHosts = computed(() =>
  hosts.value.filter((h) => Object.keys(m.overrides[h.id!] ?? {}).length),
);
const overrideChips = (h: SavedHost) =>
  (Object.entries(m.overrides[h.id!] ?? {}) as [Metric, (typeof m.rules)[Metric]][]).map(
    ([metric, r]) => describeRule(metric, r),
  );
const addable = computed(() =>
  hosts.value
    .filter((h) => !overrideHosts.value.includes(h))
    .map((h) => ({ label: hostName(h), value: h.id! })),
);
const editingId = ref<string | null>(null);
const editingHost = computed(() => hosts.value.find((h) => h.id === editingId.value));
const editorOpen = computed({
  get: () => editingId.value !== null,
  set: (open) => {
    if (open) return;
    // Drop override with no custom rule left.
    if (editingId.value && !Object.keys(m.overrides[editingId.value] ?? {}).length)
      delete m.overrides[editingId.value];
    editingId.value = null;
  },
});
function edit(id: string) {
  m.overrides[id] ??= {};
  editingId.value = id;
}
const removeOverride = (id: string) => delete m.overrides[id];

const snoozeItems = [
  { label: "1 hour", value: 60 },
  { label: "4 hours", value: 240 },
  { label: "Until tomorrow", value: 0 },
];
async function setNotify(on: boolean) {
  m.notify = on;
  if (on && "Notification" in window && Notification.permission === "default")
    await Notification.requestPermission();
}
</script>

<template>
  <div class="flex max-w-4xl flex-col gap-7">
    <div class="flex flex-col gap-1">
      <h2 class="t-title">Monitoring</h2>
      <p class="text-sm text-muted">
        Every host that signs in with a key is watched: Lynxterm keeps a background login open and
        samples every second while it runs. Turn hosts off here or from their menu. Rules turn the
        samples into alerts.
      </p>
    </div>

    <section class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <h3 class="t-section">Watched hosts</h3>
        <UBadge :label="`${watchedCount} of ${hosts.length}`" class="font-mono" />
        <span class="ml-auto text-xs text-muted">
          Each login shows in the server's auth logs and keeps one sshd (about 5 MB).
        </span>
      </div>
      <ul class="flex flex-col card">
        <li
          v-for="h in listed"
          :key="h.id"
          class="flex min-h-12 items-center gap-3 border-t border-default px-4 py-2 first:border-t-0"
        >
          <USwitch
            :model-value="isWatched(h)"
            :disabled="!h.keyId"
            :aria-label="`Watch ${hostName(h)}`"
            @update:model-value="setWatched(h, $event)"
          />
          <span
            class="size-2 shrink-0 rounded-full"
            :style="{ backgroundColor: groupColor(h.group) || 'var(--ui-border-accented)' }"
          />
          <span
            class="min-w-0 flex-1 truncate font-mono text-xs"
            :class="!isWatched(h) && 'text-muted'"
          >
            {{ hostName(h) }}
          </span>
          <UBadge v-if="!h.keyId" label="password: only while a terminal is open" size="sm" />
          <UBadge
            v-if="m.overrides[h.id!]"
            :label="`overrides ${Object.keys(m.overrides[h.id!]!).length}`"
            size="sm"
            class="font-mono"
          />
        </li>
        <li v-if="!hosts.length" class="px-4 py-3 text-sm text-muted">No saved hosts yet.</li>
        <li v-if="hosts.length > 6" class="flex justify-center border-t border-default py-1.5">
          <UButton
            :label="showAll ? 'Show fewer' : `Show all ${hosts.length}`"
            size="xs"
            color="neutral"
            variant="link"
            @click="showAll = !showAll"
          />
        </li>
      </ul>
    </section>

    <section class="flex flex-col gap-2.5">
      <div class="flex flex-col gap-0.5">
        <h3 class="t-section">Thresholds</h3>
        <p class="text-xs text-muted">
          Defaults for every watched host. An alert fires when a value stays above the line for the
          whole time, and ends after a minute below the clear line.
        </p>
      </div>
      <div class="card">
        <AlertRules v-model="m.rules" />
      </div>
    </section>

    <section class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <div class="flex flex-col gap-0.5">
          <h3 class="t-section">Per-host overrides</h3>
          <p class="text-xs text-muted">
            Only the rules you change; everything else follows the defaults.
          </p>
        </div>
        <USelectMenu
          :items="addable"
          value-key="value"
          placeholder="Add override…"
          :search-input="{ placeholder: 'Find a host' }"
          size="sm"
          class="ml-auto w-48"
          :disabled="!addable.length"
          @update:model-value="(id: string) => edit(id)"
        />
      </div>
      <ul v-if="overrideHosts.length" class="flex flex-col card">
        <li
          v-for="h in overrideHosts"
          :key="h.id"
          class="flex min-h-12 flex-wrap items-center gap-3 border-t border-default px-4 py-2 first:border-t-0"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :style="{ backgroundColor: groupColor(h.group) || 'var(--ui-border-accented)' }"
          />
          <span class="w-36 truncate font-mono text-xs">{{ hostName(h) }}</span>
          <span class="flex min-w-0 flex-1 flex-wrap gap-1.5">
            <UBadge v-for="c in overrideChips(h)" :key="c" :label="c" size="sm" class="font-mono" />
          </span>
          <UButton label="Edit" size="xs" color="neutral" variant="ghost" @click="edit(h.id!)" />
          <UButton
            label="Remove"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="removeOverride(h.id!)"
          />
        </li>
      </ul>
      <p v-else class="text-sm text-muted">
        No overrides. Every watched host follows the defaults.
      </p>
    </section>

    <section class="flex flex-col gap-2.5">
      <h3 class="t-section">When an alert fires</h3>
      <ul class="flex flex-col card">
        <li class="flex min-h-11 items-center gap-3 px-4 py-2">
          <span class="flex-1 text-sm"
            >Mark the host's card red and add the alert to its activity</span
          >
          <UBadge label="always" size="sm" class="font-mono" />
        </li>
        <li class="flex min-h-11 items-center gap-3 border-t border-default px-4 py-2">
          <span class="flex-1 text-sm">Show a notification</span>
          <USwitch
            :model-value="m.notify"
            aria-label="Show a notification"
            @update:model-value="setNotify"
          />
        </li>
        <li class="flex min-h-11 items-center gap-3 border-t border-default px-4 py-2">
          <span class="flex-1 text-sm">
            Snooze length
            <span class="block text-xs text-muted">From the host's menu while it has an alert</span>
          </span>
          <USelect
            v-model="m.snooze"
            :items="snoozeItems"
            size="sm"
            class="w-40"
            aria-label="Snooze length"
          />
        </li>
      </ul>
    </section>

    <p class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-info-duotone" class="size-[18px]" />
      Saved on this device only. 7-day history is set per host, in its Monitor panel.
    </p>

    <UModal
      v-model:open="editorOpen"
      :title="editingHost ? `Rules for ${hostName(editingHost)}` : ''"
      description="Tick a rule to give this host its own values."
      :ui="{ content: 'max-w-3xl' }"
    >
      <template v-if="editingId" #body>
        <div class="rounded-xl border border-default">
          <AlertRules v-model="m.overrides[editingId]!" :inherit="m.rules" />
        </div>
      </template>
      <template #footer>
        <UButton label="Done" class="ml-auto" @click="editorOpen = false" />
      </template>
    </UModal>
  </div>
</template>
