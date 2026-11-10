import { invoke } from "@tauri-apps/api/core";

type Target = { user: string; host: string; port: number };
type Stream = { samples: Sample[]; error: string; viewers: number; running: boolean };

const streams = reactive(new Map<string, Stream>());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fixed metrics.rs script: over open terminal if any, else background connection (saved
 *  key-based hosts only; passwords never stored). */
export function runMetrics(h: Target, action: string) {
  const session = useSessions().sessionFor(h) ?? null;
  const saved = savedHost(h);
  if (session === null && !saved?.keyId)
    return Promise.reject("Uses a password, so open a terminal to it first");
  return invoke<string>("metrics", { session, hostId: saved?.id ?? "", action });
}

async function loop(s: Stream, h: Target) {
  s.running = true;
  while (s.viewers > 0) {
    if (document.hidden) {
      await sleep(1000);
      continue;
    }
    try {
      // Each reading measures CPU over 1s on server: loop paces itself.
      s.samples = [...s.samples, ...parseSamples(await runMetrics(h, "sample"))].slice(-300);
      s.error = "";
      detectOs(h);
      ensureHistory(h);
    } catch (e) {
      s.error = String(e);
      await sleep(5000);
    }
  }
  s.running = false;
  s.samples = [];
  s.error = "";
  const saved = savedHost(h);
  if (saved) invoke("metrics_unwatch", { hostId: saved.id }).catch(() => {});
}

function subscribe(h: Target) {
  const key = hostKey(h);
  if (!streams.has(key)) streams.set(key, { samples: [], error: "", viewers: 0, running: false });
  const s = streams.get(key)!;
  s.viewers++;
  if (!s.running) loop(s, h);
  return () => s.viewers--;
}

export const liveOf = (h: Target) => streams.get(hostKey(h));

export function useLiveMetrics(targets: () => Target[]) {
  watch(
    () => targets().map(hostKey).join("\n"),
    (_, __, onCleanup) => {
      const stops = targets().map(subscribe);
      onCleanup(() => stops.forEach((stop) => stop()));
    },
    { immediate: true },
  );
}

const askedOs = new Set<string>();
export function detectOs(h: Target) {
  const saved = savedHost(h);
  if (!saved || saved.os || askedOs.has(hostKey(h))) return;
  askedOs.add(hostKey(h));
  runMetrics(h, "os")
    .then((out) => {
      const os = out.match(/^os (\S+)$/m)?.[1];
      if (os) return useHosts().save({ ...saved, os });
    })
    .catch(() => {});
}

const historyChecks = new Map<string, Promise<void>>();
export function ensureHistory(h: Target) {
  const key = hostKey(h);
  if (useSettings().noHistoryHosts.includes(key)) return Promise.resolve();
  if (!historyChecks.has(key))
    historyChecks.set(
      key,
      runMetrics(h, "history")
        .then(async (out): Promise<void> => {
          if (!out.startsWith("on")) await installHistory(h);
        })
        .catch((e) => {
          logActivity(h, {
            kind: "monitoring",
            title: "Could not keep monitoring history",
            detail: String(e),
            ok: false,
          });
        }),
    );
  return historyChecks.get(key)!;
}

export async function installHistory(h: Target) {
  await runMetrics(h, "install");
  logActivity(h, {
    kind: "monitoring",
    title: "Turned on monitoring history",
    detail: "cron job, ~/.lynxterm/metrics",
  });
}
