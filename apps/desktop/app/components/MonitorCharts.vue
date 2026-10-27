<script setup lang="ts">
// Live and saved metrics for one server. Flat list in session Monitor panel; `wide`: tiles in
// host detail on Hosts page. Live part is host's shared stream (useLiveMetrics).
const props = defineProps<{
  target: { user: string; host: string; port: number };
  wide?: boolean;
}>();
const log = (entry: Omit<Activity, "at">) => logActivity(props.target, entry);
const toast = useToast();
const settings = useSettings();

useLiveMetrics(() => [props.target]);
const stream = computed(() => liveOf(props.target));

const history = shallowRef<Sample[]>([]); // server's saved samples, oldest first
const keeping = ref<boolean>(); // server cron job installed? undefined while loading
const historyError = ref("");
const busy = ref(false);
const error = computed(() => stream.value?.error || historyError.value);
const samples = computed(() => [...history.value, ...(stream.value?.samples ?? [])]);

watch(
  () => hostKey(props.target),
  (key) => {
    history.value = [];
    keeping.value = undefined;
    historyError.value = "";
    // after default setup, so first-seen server shows as keeping it
    ensureHistory(props.target)
      .then(() => runMetrics(props.target, "history"))
      .then((out) => {
        if (key !== hostKey(props.target)) return;
        keeping.value = out.startsWith("on");
        history.value = parseSamples(out);
      })
      .catch((e) => (historyError.value = String(e)));
  },
  { immediate: true },
);

// Unticking remembered per server so default setup leaves it off; ticking again clears that.
const optOut = (on: boolean) => {
  const key = hostKey(props.target);
  const rest = settings.noHistoryHosts.filter((k) => k !== key);
  settings.noHistoryHosts = on ? [...rest, key] : rest;
};

async function install() {
  optOut(false);
  busy.value = true;
  try {
    await runMetrics(props.target, "install");
    keeping.value = true;
    toast.add({ title: "Keeping 7 days of history on this server", icon: "i-ph-check" });
    log({
      kind: "monitoring",
      title: "Turned on monitoring history",
      detail: "cron job, ~/.lynxterm/metrics",
    });
  } catch (e) {
    toast.add({ title: String(e), color: "error" });
    log({
      kind: "monitoring",
      title: "Turning on monitoring history failed",
      detail: String(e),
      ok: false,
    });
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const ok = await askConfirm({
    title: "Stop keeping history?",
    description: "Removes the cron job and the 7 days of samples saved on the server.",
    detail: "~/.lynxterm/metrics",
    label: "Stop and delete",
  });
  if (!ok) return;
  optOut(true);
  await withBusy(busy, async () => {
    await runMetrics(props.target, "remove");
    keeping.value = false;
    log({
      kind: "monitoring",
      title: "Turned off monitoring history",
      detail: "removed the cron job and its data",
    });
    history.value = [];
  });
}
const toggleHistory = (on: boolean | "indeterminate") => (on ? install() : remove());
const moreMenu = computed(() => [
  [
    {
      type: "checkbox" as const,
      label: "Keep 7-day history on host",
      icon: "i-ph-clock-counter-clockwise-duotone",
      checked: keeping.value ?? false,
      disabled: busy.value || keeping.value === undefined,
      onUpdateChecked: toggleHistory,
    },
  ],
]);
const block = computed(() =>
  props.wide
    ? "flex min-w-0 flex-col gap-2 rounded-lg bg-muted p-3"
    : "flex flex-col gap-2 border-b border-default py-3",
);

// 5m is live view: 2.5 s slots, filled by one-a-second live samples. Longer ranges use slots
// of at least a minute, history's sample rate, so none sit empty.
const ranges = [
  { label: "5m", seconds: 300 },
  { label: "1h", seconds: 3600 },
  { label: "24h", seconds: 86400 },
  { label: "7d", seconds: 604800 },
];
const range = ref(ranges[0]!);
const slots = computed(() =>
  range.value.seconds <= 300 ? 120 : Math.min(120, range.value.seconds / 60),
);

const latest = computed(() => samples.value.at(-1));
// Server time: clock off on either side doesn't shift chart.
const to = computed(() => latest.value?.t ?? Date.now() / 1000);
const from = computed(() => to.value - range.value.seconds);

const charts = [
  {
    label: "CPU",
    value: (s: Sample) => s.cpu,
    now: (s: Sample) => `${s.cpu}%`,
    stroke: "stroke-primary",
    fill: "fill-primary/12",
    tone: "text-primary",
  },
  {
    label: "Memory",
    value: memPct,
    now: (s: Sample) => `${(s.memUsed / 1024).toFixed(1)} / ${(s.memTotal / 1024).toFixed(1)} GB`,
    stroke: "stroke-info",
    fill: "fill-info/12",
    tone: "text-info",
  },
];
// Gaps up to two minutes are history's sample rate, not outage: bridged.
const gap = computed(() => Math.ceil((120 * slots.value) / range.value.seconds));
const slotted = (value: (s: Sample) => number | undefined) =>
  bridge(buckets(samples.value, value, from.value, to.value, slots.value), gap.value);
const series = computed(() => charts.map((c) => slotted(c.value)));

// Step line, flat across each slot so even single slot shows; broken where no data.
function path(values: (number | null)[], max = 100) {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) return (pen = false);
    const y = 100 - Math.min(100, (100 * v) / max);
    d += `${pen ? "L" : "M"}${i} ${y}L${i + 1} ${y}`;
    pen = true;
  });
  return d;
}
/** Same line closed down to floor, one shape per unbroken run. */
function area(values: (number | null)[], max = 100) {
  let d = "";
  let start = -1;
  values.forEach((v, i) => {
    if (v !== null) {
      const y = 100 - Math.min(100, (100 * v) / max);
      d += `${start < 0 ? `M${i} 100` : ""}L${i} ${y}L${i + 1} ${y}`;
      if (start < 0) start = i;
    }
    if (start >= 0 && (v === null || i === values.length - 1)) {
      d += `L${v === null ? i : i + 1} 100Z`;
      start = -1;
    }
  });
  return d;
}

// Network: two lines in Mb/s, scaled to busiest slot. At least 1 Mb/s so idle link stays near
// floor instead of filling chart.
const rx = computed(() => slotted((s) => (s.rx !== undefined ? mbps(s.rx) : undefined)));
const tx = computed(() => slotted((s) => (s.tx !== undefined ? mbps(s.tx) : undefined)));
const netMax = computed(() =>
  Math.max(1, ...rx.value.map((v) => v ?? 0), ...tx.value.map((v) => v ?? 0)),
);
const hasNet = computed(() => rx.value.some((v) => v !== null));
const netReadout = computed(() => {
  if (hover.value !== null) {
    const r = rx.value[hover.value];
    const t = tx.value[hover.value];
    return r == null ? "No data" : `rx ${r.toFixed(1)}, tx ${(t ?? 0).toFixed(1)} Mb/s`;
  }
  const s = latest.value;
  return s?.rx !== undefined ? `rx ${rate(s.rx)}, tx ${rate(s.tx ?? 0)}` : "–";
});

// Hover moves one crosshair across all charts, shows that slot's values.
const hover = ref<number | null>(null);
function onMove(e: MouseEvent) {
  const box = (e.currentTarget as Element).getBoundingClientRect();
  hover.value = Math.min(
    slots.value - 1,
    Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * slots.value)),
  );
}
const hoverTime = computed(() => {
  if (hover.value === null) return "";
  const t = from.value + ((hover.value + 0.5) * range.value.seconds) / slots.value;
  return new Date(t * 1000).toLocaleString([], {
    weekday: range.value.seconds > 86400 ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  });
});
function readout(i: number) {
  if (hover.value !== null) {
    const v = series.value[i]![hover.value];
    return v === null || v === undefined ? "No data" : `${Math.round(v)}%`;
  }
  return latest.value ? charts[i]!.now(latest.value) : "–";
}

// Charts drawn: lines (first one filled), scale, readout.
const shown = computed(() => [
  ...charts.map((c, i) => ({
    ...c,
    note: "",
    max: 100,
    lines: [{ values: series.value[i]!, stroke: c.stroke, dashed: false }],
    readout: readout(i),
  })),
  ...(hasNet.value
    ? [
        {
          label: "Network",
          note: ", received solid and sent dashed",
          tone: "text-success",
          fill: "fill-success/10",
          max: netMax.value,
          lines: [
            { values: rx.value, stroke: "stroke-success", dashed: false },
            { values: tx.value, stroke: "stroke-(--ui-text-muted)", dashed: true },
          ],
          readout: netReadout.value,
        },
      ]
    : []),
]);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex items-center gap-2" :class="!wide && 'px-3.5 pt-3'">
      <span v-if="wide" class="t-label">Monitoring</span>
      <UBadge
        v-if="latest && !error"
        :label="hoverTime || 'live, 1 s'"
        size="sm"
        class="font-mono"
      />
      <UFieldGroup size="xs" class="ml-auto">
        <UButton
          v-for="r in ranges"
          :key="r.label"
          :label="r.label"
          color="neutral"
          :variant="range === r ? 'soft' : 'outline'"
          :aria-pressed="range === r"
          @click="range = r"
        />
      </UFieldGroup>
      <UDropdownMenu :items="moreMenu" :content="{ align: 'end' }">
        <UButton
          icon="i-ph-dots-three"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="Monitoring options"
        />
      </UDropdownMenu>
    </div>
    <div v-if="error" class="flex flex-col gap-1 pt-3 text-sm" :class="!wide && 'px-3.5'">
      <span class="font-medium text-error">No answer.</span>
      <span class="truncate font-mono text-xs text-muted" :title="error">{{ error }}</span>
      <span class="text-muted">Retrying every few seconds.</span>
    </div>

    <!-- nothing to chart from server that never answered -->
    <div
      v-if="!error || samples.length"
      class="min-h-0 flex-1"
      :class="
        wide
          ? 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 pt-3'
          : 'overflow-y-auto px-3.5'
      "
    >
      <section v-for="(chart, i) in shown" :key="chart.label" :class="block">
        <div class="flex items-center gap-2 text-xs text-toned">
          <span>{{ chart.label }}</span>
          <span
            class="ml-auto truncate font-mono font-semibold tabular-nums"
            :class="[chart.tone, wide && i === 0 && 'text-lg leading-none']"
            >{{ chart.readout }}</span
          >
        </div>
        <svg
          :viewBox="`0 0 ${slots} 100`"
          preserveAspectRatio="none"
          class="w-full cursor-crosshair"
          :class="wide ? 'h-12' : 'h-9'"
          role="img"
          :aria-label="`${chart.label} over the last ${range.label}${chart.note}`"
          @mousemove="onMove"
          @mouseleave="hover = null"
        >
          <path :d="area(chart.lines[0]!.values, chart.max)" :class="chart.fill" stroke="none" />
          <path
            v-for="line in chart.lines"
            :key="line.stroke"
            :d="path(line.values, chart.max)"
            fill="none"
            :class="line.stroke"
            stroke-width="1.5"
            stroke-linejoin="round"
            :stroke-dasharray="line.dashed ? '3 2' : undefined"
            vector-effect="non-scaling-stroke"
          />
          <line
            v-if="hover !== null"
            :x1="hover + 0.5"
            :x2="hover + 0.5"
            y1="0"
            y2="100"
            class="stroke-(--ui-text-muted)"
            vector-effect="non-scaling-stroke"
          />
        </svg>
      </section>
      <section :class="block">
        <div class="flex items-center gap-2 text-xs text-toned">
          <span>Disk /</span>
          <span class="ml-auto font-mono font-semibold text-success tabular-nums">
            {{ latest ? `${latest.disk}%` : "–" }}
          </span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-accented">
          <div
            class="h-full rounded-full bg-success"
            :style="{ width: `${Math.min(100, latest?.disk ?? 0)}%` }"
          />
        </div>
        <div class="mt-auto flex flex-wrap gap-1.5 pt-1">
          <UBadge
            v-if="latest?.load !== undefined"
            :label="`load ${latest.load.toFixed(2)}`"
            size="sm"
            class="font-mono"
          />
          <UBadge
            v-if="latest?.cores"
            :label="`${latest.cores} cores`"
            size="sm"
            class="font-mono"
          />
        </div>
      </section>
    </div>
  </div>
</template>
