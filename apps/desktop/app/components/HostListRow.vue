<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
// Explicit (not auto-imported): defineProps resolves only imported types to runtime Object.
import type { Sample } from "~/composables/metrics";
import type { SavedHost } from "~/composables/useHosts";

const props = defineProps<{
  host: SavedHost;
  selected?: boolean;
  last?: Sample;
  alerting?: boolean;
  unreachable?: boolean;
  menu: DropdownMenuItem[][];
}>();
const emit = defineEmits<{ select: []; connect: [] }>();

const tags = computed(() => {
  const t = props.host.tags ?? [];
  return t.length > 2 ? [...t.slice(0, 2), `+${t.length - 2}`] : t;
});
const ring = (r: number, pct: number) => {
  const c = 2 * Math.PI * r;
  return `${(c * Math.max(0, Math.min(100, pct))) / 100} ${c}`;
};
const cpu = computed(() => props.last?.cpu ?? 0);
const mem = computed(() => (props.last ? Math.round(memPct(props.last)) : 0));
</script>

<template>
  <UContextMenu :items="menu">
    <li>
      <button
        class="flex min-h-14 w-full items-center gap-3 border-b border-muted px-4 py-2 text-left transition-colors"
        :class="selected ? 'bg-row shadow-[inset_3px_0_0_var(--ui-primary)]' : 'hover:bg-row'"
        title="Click for details, double-click to open a terminal"
        :aria-pressed="selected"
        @click="emit('select')"
        @dblclick="emit('connect')"
        @keydown.enter.prevent="emit('connect')"
      >
        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="truncate font-medium">{{ hostName(host) }}</span>
            <span
              v-for="t in tags"
              :key="t"
              class="shrink-0 rounded bg-accented px-1.5 py-px font-mono text-[10.5px] text-toned"
            >
              {{ t }}
            </span>
          </span>
          <span class="block truncate font-mono text-[11px] text-muted">{{ hostLabel(host) }}</span>
        </span>

        <span v-if="last" class="flex shrink-0 items-center gap-2">
          <span
            class="min-w-8 text-right font-mono text-xs font-medium tabular-nums"
            :class="alerting ? 'text-error' : 'text-toned'"
          >
            {{ cpu }}%
          </span>
          <svg
            width="30"
            height="30"
            viewBox="0 0 30 30"
            role="img"
            :aria-label="`CPU ${cpu}%, memory ${mem}%`"
          >
            <title>CPU {{ cpu }}%, memory {{ mem }}%</title>
            <g transform="rotate(-90 15 15)" fill="none" stroke-width="3" stroke-linecap="round">
              <circle cx="15" cy="15" r="12.5" class="stroke-(--ui-bg-accented)" />
              <circle
                cx="15"
                cy="15"
                r="12.5"
                :class="alerting ? 'stroke-error' : 'stroke-success'"
                :stroke-dasharray="ring(12.5, cpu)"
              />
              <circle cx="15" cy="15" r="8" class="stroke-(--ui-bg-accented)" />
              <circle cx="15" cy="15" r="8" class="stroke-info" :stroke-dasharray="ring(8, mem)" />
            </g>
          </svg>
        </span>
        <span
          v-else-if="unreachable"
          class="shrink-0 rounded-full border border-error/40 px-2.5 py-0.5 text-[11.5px] font-medium text-error"
        >
          No answer
        </span>
      </button>
    </li>
  </UContextMenu>
</template>
