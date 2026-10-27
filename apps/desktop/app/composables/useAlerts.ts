// Watched hosts only. Rule fires when value stays at or above `above` for `for` minutes; clears
// after a minute below `clear`, so no flapping. Unreachable fires after `for` minutes silent.
export type Metric = "cpu" | "memory" | "disk" | "load" | "network" | "unreachable";
const SAMPLED = ["cpu", "memory", "disk", "load", "network"] as const;
export type Rule = { on: boolean; above: number; for: number; clear: number };

export const METRICS: { id: Metric; label: string; short: string; unit: string }[] = [
  { id: "cpu", label: "CPU", short: "cpu", unit: "%" },
  { id: "memory", label: "Memory", short: "mem", unit: "%" },
  { id: "disk", label: "Disk /", short: "disk", unit: "%" },
  { id: "load", label: "Load (1 min)", short: "load", unit: "x cores" },
  { id: "network", label: "Network", short: "net", unit: "Mb/s" },
  { id: "unreachable", label: "Unreachable", short: "unreachable", unit: "" },
];

export const DEFAULT_RULES: Record<Metric, Rule> = {
  cpu: { on: true, above: 80, for: 5, clear: 70 },
  memory: { on: true, above: 85, for: 10, clear: 75 },
  disk: { on: true, above: 85, for: 0, clear: 80 },
  load: { on: true, above: 1.5, for: 5, clear: 1 },
  network: { on: true, above: 800, for: 5, clear: 600 },
  unreachable: { on: true, above: 0, for: 2, clear: 0 },
};

const CLEAR_AFTER = 60; // seconds below clear line before alert ends

/** Host's override, else default. */
export function ruleFor(hostId: string | undefined, metric: Metric): Rule {
  const m = useSettings().monitoring;
  return (hostId && m.overrides[hostId]?.[metric]) || m.rules[metric];
}

export function describeRule(metric: Metric, r: Rule) {
  const { short } = METRICS.find((x) => x.id === metric)!;
  if (!r.on) return `${short} off`;
  if (metric === "unreachable") return `${short} ${r.for} min`;
  return `${short} ${threshold(metric, r)}, ${r.for ? `${r.for} min` : "at once"}`;
}

function threshold(metric: Metric, r: Rule) {
  const { unit } = METRICS.find((x) => x.id === metric)!;
  return unit === "%" ? `${r.above}%` : `${r.above} ${unit}`;
}

type Alert = { metric: Metric; label: string; value: string };

type Track = { since?: number; belowSince?: number; active: boolean; value: string };
/** By `hostKey|metric`. */
const tracks = reactive(new Map<string, Track>());
/** Last handled sample time, by hostKey. */
const handled = new Map<string, number>();
/** Snoozed until (ms), by hostKey. */
const snoozed = reactive(new Map<string, number>());

/** undefined when server didn't report it (load and network on samples from before they were
 *  collected). Network: busier direction. */
function valueOf(metric: (typeof SAMPLED)[number], s: Sample) {
  if (metric === "cpu") return s.cpu;
  if (metric === "memory") return memPct(s);
  if (metric === "disk") return s.disk;
  if (metric === "load") return s.load !== undefined && s.cores ? s.load / s.cores : undefined;
  return s.rx !== undefined ? mbps(Math.max(s.rx, s.tx ?? 0)) : undefined;
}
function show(metric: (typeof SAMPLED)[number], v: number) {
  if (metric === "load") return `${v.toFixed(1)} x cores`;
  if (metric === "network") return `${Math.round(v)} Mb/s`;
  return `${Math.round(v)}%`;
}

const isSnoozed = (h: SavedHost) => (snoozed.get(hostKey(h)) ?? 0) > Date.now();

export function alertsFor(h: SavedHost): Alert[] {
  if (isSnoozed(h)) return [];
  return METRICS.flatMap(({ id, label }) => {
    const t = tracks.get(`${hostKey(h)}|${id}`);
    return t?.active ? [{ metric: id, label, value: t.value }] : [];
  });
}

export function snooze(h: SavedHost) {
  const minutes = useSettings().monitoring.snooze;
  const until = new Date();
  if (minutes) until.setMinutes(until.getMinutes() + minutes);
  else until.setHours(24 + 8, 0, 0, 0); // tomorrow, 8:00
  snoozed.set(hostKey(h), until.getTime());
}

/** Call once, in a component's setup. */
export function startAlerts() {
  const toast = useToast();
  const { hosts } = useHosts();
  const settings = useSettings();

  function fire(h: SavedHost, metric: Metric, value: string, r: Rule) {
    const { label } = METRICS.find((x) => x.id === metric)!;
    const title =
      metric === "unreachable"
        ? `${hostName(h)} is not answering`
        : `${hostName(h)}: ${label} at ${value}`;
    const detail =
      metric === "unreachable"
        ? `No answer for ${r.for} min`
        : `At or above ${threshold(metric, r)}${r.for ? ` for ${r.for} min` : ""}`;
    logActivity(h, { kind: "monitoring", title, detail, ok: false });
    if (isSnoozed(h)) return;
    toast.add({ title, description: detail, color: "error", icon: "i-ph-warning-circle-duotone" });
    if (
      settings.monitoring.notify &&
      "Notification" in window &&
      Notification.permission === "granted"
    )
      new Notification(title, { body: detail });
  }

  function step(h: SavedHost, metric: (typeof SAMPLED)[number], s: Sample) {
    const key = `${hostKey(h)}|${metric}`;
    const r = ruleFor(h.id, metric);
    if (!r.on) return tracks.delete(key);
    const v = valueOf(metric, s);
    if (v === undefined) return;
    const t = tracks.get(key) ?? { active: false, value: "" };
    t.value = show(metric, v);
    if (!t.active) {
      t.belowSince = undefined;
      if (v < r.above) t.since = undefined;
      else if (s.t - (t.since ??= s.t) >= r.for * 60) {
        t.active = true;
        fire(h, metric, t.value, r);
      }
    } else if (v >= r.clear) t.belowSince = undefined;
    else if (s.t - (t.belowSince ??= s.t) >= CLEAR_AFTER) {
      t.active = false;
      t.since = undefined;
    }
    tracks.set(key, t);
  }

  // Each live host's new samples, oldest first.
  watch(
    () => hosts.value.map((h) => liveOf(h)?.samples.at(-1)?.t),
    () => {
      for (const h of hosts.value) {
        const samples = liveOf(h)?.samples ?? [];
        const from = handled.get(hostKey(h)) ?? 0;
        for (const s of samples) if (s.t > from) for (const m of SAMPLED) step(h, m, s);
        if (samples.length) handled.set(hostKey(h), samples.at(-1)!.t);
      }
    },
  );

  // Unreachable: error that lasts. Checked on timer, since retries repeat the error.
  setInterval(() => {
    for (const h of hosts.value) {
      const key = `${hostKey(h)}|unreachable`;
      const r = ruleFor(h.id, "unreachable");
      const stream = liveOf(h);
      if (!r.on || !stream) {
        tracks.delete(key);
        continue;
      }
      const t = tracks.get(key) ?? { active: false, value: "no answer" };
      if (!stream.error) {
        Object.assign(t, { active: false, since: undefined });
      } else if (!t.active && Date.now() / 1000 - (t.since ??= Date.now() / 1000) >= r.for * 60) {
        t.active = true;
        fire(h, "unreachable", t.value, r);
      }
      tracks.set(key, t);
    }
  }, 10_000);
}
