<script setup lang="ts">
const { hosts, save, remove } = useHosts();
const { keys } = useKeys();
const { names: groups, ensure: ensureGroup } = useGroups();
const { connect, openFiles } = useSessions();
const settings = useSettings();
const toast = useToast();
const view = useView();

// Key hosts watched unless turned off: stream while app open, even without terminal.
useLiveMetrics(() => hosts.value.filter(isWatched));
const lastOf = (h: SavedHost) => liveOf(h)?.samples.at(-1);
const unreachable = (h: SavedHost) => !lastOf(h) && !!liveOf(h)?.error;
const needsLook = (h: SavedHost) => alertsFor(h).length > 0 || unreachable(h);

function toggleWatch(h: SavedHost) {
  const on = !isWatched(h);
  setWatched(h, on);
  toast.add({
    title: on ? `Watching ${hostName(h)}` : `Stopped watching ${hostName(h)}`,
    description: on
      ? "Lynxterm stays logged in to it while open; the login shows in its auth logs."
      : "Turn it back on from the host menu or Settings › Monitoring.",
    icon: "i-ph-chart-line-duotone",
  });
}

const list = useTemplateRef<{ focus: () => void }>("list");
// Newline between fields: a one-line query never matches across two.
const { filter, shown: byText } = useFilter(
  () => hosts.value,
  (h) => [h.name, h.host, h.user, h.group, ...(h.tags ?? [])].join("\n"),
);
const group = ref<string | null>(null); // null = all
const rank = (h: SavedHost) => (h.group ? groups.value.indexOf(h.group) : groups.value.length);
const shown = computed(() =>
  byText.value
    .filter((h) => !group.value || h.group === group.value)
    .sort(
      (a, b) =>
        Number(needsLook(b)) - Number(needsLook(a)) ||
        rank(a) - rank(b) ||
        hostName(a).localeCompare(hostName(b)),
    ),
);
// Up to four group chips; past that, three plus menu.
const present = computed(() =>
  groups.value
    .map((name) => ({ name, count: byText.value.filter((h) => h.group === name).length }))
    .filter((g) => g.count),
);
const chips = computed(() =>
  present.value.length > 4 ? present.value.slice(0, 3) : present.value,
);
const hidden = computed(() => present.value.slice(chips.value.length));
const pickedHidden = computed(() => hidden.value.find((g) => g.name === group.value));
const moreMenu = computed(() => [
  hidden.value.map((g) => ({
    label: `${g.name}  ${g.count}`,
    icon: group.value === g.name ? "i-ph-check" : undefined,
    onSelect: () => (group.value = g.name),
  })),
]);
watch(groups, (list) => {
  if (group.value && !list.includes(group.value)) group.value = null;
});
const chip = (on: boolean) => [
  "h-7 gap-1.5 rounded-full px-3 text-xs",
  on ? "font-semibold" : "bg-muted font-normal text-toned",
];

defineShortcuts({
  "/": () => view.value === "hosts" && list.value?.focus(),
  meta_n: () => view.value === "hosts" && newHost(),
});

const selected = ref<string | null>(null);
const selectedHost = computed(
  () => hosts.value.find((h) => h.id === selected.value) ?? shown.value[0] ?? hosts.value[0],
);

const editing = ref<SavedHost | null>(null);
const isNew = computed(() => !!editing.value && !editing.value.id);
const watchNew = ref(true);
const keyItems = computed(() => [
  { label: "Password, asked each time", value: "none" },
  ...keys.value.map((k) => ({ label: k.name, value: k.id })),
]);
const keyChoice = computed({
  get: () => editing.value?.keyId || "none",
  set: (v: string) => editing.value && (editing.value.keyId = v === "none" ? "" : v),
});
// One field "deploy@10.0.4.20", stored as user and host.
const address = computed({
  get: () =>
    editing.value?.user
      ? `${editing.value.user}@${editing.value.host}`
      : (editing.value?.host ?? ""),
  set: (v: string) => {
    if (!editing.value) return;
    const at = v.lastIndexOf("@");
    editing.value.user = at >= 0 ? v.slice(0, at).trim() : "";
    editing.value.host = (at >= 0 ? v.slice(at + 1) : v).trim();
  },
});
const groupItems = computed(() => [...new Set(groups.value)].sort());
// "Create …": saved right away (with color), so list picks it up.
function addGroup(name: string) {
  if (editing.value) editing.value.group = name;
  ensureGroup(name);
}
// Normalized as typed.
const editingTags = computed({
  get: () => editing.value?.tags ?? [],
  set: (v: string[]) =>
    editing.value && (editing.value.tags = [...new Set(v.map(normalizeTag).filter(Boolean))]),
});
function newHost() {
  watchNew.value = true;
  editing.value = {
    name: "",
    group: group.value ?? "",
    host: "",
    port: 22,
    user: "",
    keyId: keys.value[0]?.id ?? "",
  };
}
async function saveHost() {
  const h = editing.value!;
  if (!h.user || !h.host) {
    toast.add({ title: "Add the user and the host, like deploy@10.0.4.20", color: "error" });
    return;
  }
  await save(h);
  const saved = hosts.value.find((x) => hostKey(x) === hostKey(h));
  if (saved && isNew.value && !watchNew.value) setWatched(saved, false);
  if (saved) selected.value = saved.id!;
  editing.value = null;
}
function connectFromEditor() {
  const h = editing.value!;
  editing.value = null;
  connect(h);
}

async function forget(h: SavedHost) {
  const ok = await askConfirm({
    title: `Delete ${hostName(h)}?`,
    description: "Removes the host from your vault on every device. Keys stay in the Keychain.",
    detail: hostKey(h),
  });
  if (!ok) return;
  if (selected.value === h.id) selected.value = null;
  await remove(h);
}

async function copySsh(h: SavedHost) {
  const command = `ssh ${h.user}@${h.host}${h.port === 22 ? "" : ` -p ${h.port}`}`;
  await copyText(command, "Copied", command);
}

/** Shared by ••• menu and right-click. */
const hostMenu = (h: SavedHost) => [
  [
    { label: "Connect", icon: "i-ph-terminal-window-duotone", onSelect: () => connect(h) },
    { label: "Open SFTP", icon: "i-ph-folder-duotone", onSelect: () => openFiles(h) },
    {
      label: "Edit",
      icon: "i-ph-pencil-simple-duotone",
      onSelect: () => ((selected.value = h.id!), (editing.value = { ...h })),
    },
    { label: "Copy SSH command", icon: "i-ph-copy-duotone", onSelect: () => copySsh(h) },
    {
      label: !h.keyId ? "Watching needs a key" : isWatched(h) ? "Stop watching" : "Watch",
      icon: "i-ph-chart-line-duotone",
      disabled: !h.keyId,
      onSelect: () => toggleWatch(h),
    },
    ...(alertsFor(h).length
      ? [
          {
            label: `Snooze alerts (${settings.monitoring.snooze ? `${settings.monitoring.snooze / 60} h` : "until tomorrow"})`,
            icon: "i-ph-bell-slash-duotone",
            onSelect: () => snooze(h),
          },
        ]
      : []),
    {
      label: "Alert rules…",
      icon: "i-ph-sliders-horizontal-duotone",
      onSelect: () => openSettings("monitoring"),
    },
  ],
  [
    {
      label: "Delete",
      icon: "i-ph-trash-duotone",
      color: "error" as const,
      onSelect: () => forget(h),
    },
  ],
];
</script>

<template>
  <div class="flex min-h-0">
    <ListColumn
      ref="list"
      v-model:filter="filter"
      title="Hosts"
      :count="hosts.length"
      placeholder="Filter by name, address, tag"
      :empty="!hosts.length && !isNew"
    >
      <template #actions>
        <UButton icon="i-ph-plus" label="New host" size="sm" @click="newHost" />
      </template>
      <template #kbd><UKbd value="/" /></template>
      <template v-if="present.length" #filters>
        <div role="group" aria-label="Show group" class="flex flex-wrap gap-1.5">
          <UButton
            v-for="g in [{ name: null, count: byText.length }, ...chips]"
            :key="g.name ?? ''"
            size="xs"
            :color="group === g.name ? 'primary' : 'neutral'"
            :variant="group === g.name ? 'solid' : 'outline'"
            :class="chip(group === g.name)"
            :aria-pressed="group === g.name"
            @click="group = group === g.name ? null : g.name"
          >
            {{ g.name ?? "All" }} <span class="opacity-75">{{ g.count }}</span>
          </UButton>
          <UDropdownMenu v-if="hidden.length" :items="moreMenu" :content="{ align: 'start' }">
            <UButton
              size="xs"
              :color="pickedHidden ? 'primary' : 'neutral'"
              :variant="pickedHidden ? 'solid' : 'outline'"
              :class="chip(!!pickedHidden)"
              trailing-icon="i-ph-caret-down"
            >
              {{
                pickedHidden
                  ? `${pickedHidden.name} ${pickedHidden.count}`
                  : `+${hidden.length} more`
              }}
            </UButton>
          </UDropdownMenu>
        </div>
      </template>

      <ListRow v-if="isNew" title="New host" subtitle="not saved yet" selected plain />
      <HostListRow
        v-for="h in shown"
        :key="h.id"
        :host="h"
        :selected="!isNew && selectedHost?.id === h.id"
        :last="lastOf(h)"
        :alerting="alertsFor(h).length > 0"
        :unreachable="unreachable(h)"
        :menu="hostMenu(h)"
        @select="((selected = h.id!), (editing = null))"
        @connect="connect(h)"
      />
      <li v-if="hosts.length && !shown.length" class="px-4 py-3 text-sm text-muted">
        Nothing matches{{ filter ? ` “${filter}”` : "" }}.
      </li>

      <template #empty>
        <EmptyState
          icon="i-ph-hard-drives-duotone"
          title="No hosts yet"
          text="Servers you add show up here, with their live usage. Nothing is connected to until you say so."
        />
      </template>
      <template v-if="hosts.length" #footer>
        <p class="flex items-center gap-2 border-t border-default px-4 py-2.5 text-xs text-muted">
          <UIcon name="i-ph-mouse-simple-duotone" class="size-4" />
          Click for details, double-click opens a terminal
        </p>
      </template>
    </ListColumn>

    <main v-if="editing" class="pane max-w-[860px]">
      <div class="flex items-center gap-3">
        <h2 class="truncate text-xl font-semibold">
          {{ isNew ? "New host" : `Edit ${hostName(editing)}` }}
        </h2>
        <UButton
          label="Cancel"
          color="neutral"
          variant="ghost"
          class="ml-auto"
          @click="editing = null"
        />
      </div>
      <form class="flex flex-col gap-4 card p-4" @submit.prevent="saveHost">
        <div class="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
          <UFormField label="Name" hint="Optional">
            <UInput v-model="editing.name" placeholder="web-3" class="w-full" />
          </UFormField>
          <UFormField label="Group" hint="Optional">
            <USelectMenu
              v-model="editing.group"
              :items="groupItems"
              create-item
              clear
              placeholder="No group"
              class="w-full"
              @create="addGroup"
            />
          </UFormField>
        </div>
        <div class="grid grid-cols-[minmax(0,1fr)_110px] gap-3.5">
          <UFormField label="Address">
            <UInput
              v-model="address"
              placeholder="deploy@10.0.4.20"
              required
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
          <UFormField label="Port">
            <UInput
              v-model.number="editing.port"
              type="number"
              required
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
        </div>
        <UFormField label="Tags" hint="Enter after each">
          <UInputTags
            v-model="editingTags"
            placeholder="Add a tag"
            class="w-full"
            :ui="{ item: 'font-mono' }"
          />
        </UFormField>
        <UFormField label="Sign in with">
          <USelect v-model="keyChoice" :items="keyItems" class="w-full" />
        </UFormField>
        <UCheckbox
          v-if="isNew"
          v-model="watchNew"
          :disabled="keyChoice === 'none'"
          label="Watch this host"
          description="Live usage and alerts while Lynxterm is open. On by default for hosts with a key."
        />
        <div class="flex flex-wrap justify-end gap-2 border-t border-default pt-3.5">
          <UButton
            label="Connect without saving"
            color="neutral"
            variant="ghost"
            :disabled="!editing.host || !editing.user"
            @click="connectFromEditor"
          />
          <UButton type="submit" label="Save" />
        </div>
      </form>
    </main>

    <HostDetails
      v-else-if="selectedHost"
      :key="selectedHost.id"
      :host="selectedHost"
      :menu="hostMenu(selectedHost)"
      @connect="connect(selectedHost)"
    />

    <EmptyLogo v-else />
  </div>
</template>
