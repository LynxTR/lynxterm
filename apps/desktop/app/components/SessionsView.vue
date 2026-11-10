<script setup lang="ts">
const { tabs, current, focusedPane, activePane, isSplit, toggleSplit, closePane, panel } =
  useSessions();

const tool = (
  id: NonNullable<typeof panel.value>,
  label: string,
  icon: string,
  keys: string[] = [],
) => ({
  label,
  name: label,
  icon,
  keys,
  on: panel.value === id,
  toggle: () => (panel.value = panel.value === id ? null : id),
});
const rail = computed(() => [
  tool("sftp", "SFTP", "i-ph-folder-duotone", ["Shift", "F"]),
  tool("monitor", "Monitor", "i-ph-chart-line-duotone", ["Shift", "M"]),
  tool("snippets", "Snippets", "i-ph-code-duotone", ["Shift", "S"]),
  tool("forwards", "Forward", "i-ph-arrows-left-right"),
  {
    label: "Split",
    name: isSplit.value ? "Close split pane" : "Split pane",
    icon: isSplit.value ? "i-ph-square-duotone" : "i-ph-columns-duotone",
    keys: ["D"],
    on: isSplit.value,
    toggle: () => current.value !== null && toggleSplit(),
  },
]);
defineShortcuts(
  computed(() =>
    Object.fromEntries(
      rail.value
        .filter((t) => t.keys.length)
        .map((t) => [
          `meta_${t.keys.join("_").toLowerCase()}`,
          { usingInput: true, handler: t.toggle },
        ]),
    ),
  ),
);
watch(
  () => tabs.value.flatMap((t) => t.panes).filter((p) => p.session !== undefined),
  (panes) => panes.forEach((p) => detectOs(p.target)),
);
</script>

<template>
  <div class="flex min-h-0 bg-default">
    <!-- v-show keeps background sessions alive -->
    <div
      v-for="t in tabs"
      v-show="t.key === current"
      :key="t.key"
      class="flex min-w-0 flex-1 animate-fade divide-x divide-default overflow-hidden"
    >
      <div v-for="p in t.panes" :key="p.key" class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <SshTerminal
          :target="p.target"
          :closable="t.panes.length > 1"
          @state="p.state = $event"
          @session="p.session = $event"
          @focus="focusedPane = p.key"
          @close="closePane(t, p.key)"
        />
      </div>
    </div>

    <div
      class="flex shrink-0 justify-start overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      :style="{ width: panel ? '340px' : '0px' }"
    >
      <Transition
        enter-active-class="transition-opacity duration-150 ease-out"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-200 ease-in"
        leave-to-class="opacity-0"
        mode="out-in"
      >
        <SftpPanel
          v-if="panel === 'sftp'"
          :session="activePane?.session"
          :target="activePane?.target"
          @close="panel = null"
        />
        <ToolPanel
          v-else-if="panel === 'monitor'"
          title="Monitor"
          :chip="activePane?.target && hostName(activePane.target)"
          @close="panel = null"
        >
          <MonitorCharts v-if="activePane?.target" :target="activePane.target" />
        </ToolPanel>
        <SnippetsPanel v-else-if="panel === 'snippets'" @close="panel = null" />
        <ForwardsPanel
          v-else-if="panel === 'forwards'"
          :target="activePane?.target"
          @close="panel = null"
        />
      </Transition>
    </div>

    <nav
      aria-label="Terminal tools"
      class="flex w-14 shrink-0 flex-col items-center gap-0.5 border-l border-default bg-sunken px-1 py-2"
    >
      <template v-for="t in rail" :key="t.label">
        <USeparator v-if="t.label === 'Split'" class="my-1 w-8" />
        <UTooltip
          :text="t.name"
          :kbds="t.keys.length ? ['Ctrl', ...t.keys] : undefined"
          :content="{ side: 'left' }"
        >
          <button
            class="flex h-13 w-12 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] transition-colors"
            :class="
              t.on ? 'bg-accented text-primary' : 'text-muted hover:bg-elevated hover:text-default'
            "
            :aria-label="t.name"
            :aria-pressed="t.on"
            @click="t.toggle"
          >
            <UIcon :name="t.icon" class="size-[18px]" />
            {{ t.label }}
          </button>
        </UTooltip>
      </template>
    </nav>
  </div>
</template>
