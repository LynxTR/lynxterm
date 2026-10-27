// One sample per line from server metrics script (src-tauri/src/metrics.rs):
// `unix_time cpu% mem_used_mb mem_total_mb disk% load1 cores rx_B/s tx_B/s`. History saved
// before load and network has only first five.
export type Sample = {
  t: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  disk: number;
  load?: number;
  cores?: number;
  /** Bytes/s in and out, all interfaces except loopback. */
  rx?: number;
  tx?: number;
};

export const memPct = (s: Sample) => (s.memTotal ? (100 * s.memUsed) / s.memTotal : 0);
export const mbps = (bytesPerSec: number) => (bytesPerSec * 8) / 1e6;

export function rate(bytesPerSec: number) {
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  return `${Math.round(bits / 1e3)} kb/s`;
}

export function parseSamples(text: string): Sample[] {
  return text.split("\n").flatMap((line) => {
    const f = line.trim().split(/\s+/).map(Number);
    if ((f.length !== 5 && f.length !== 9) || f.some((n) => !Number.isFinite(n))) return [];
    const [t, cpu, memUsed, memTotal, disk, load, cores, rx, tx] = f as number[];
    const base = { t: t!, cpu: cpu!, memUsed: memUsed!, memTotal: memTotal!, disk: disk! };
    return [f.length === 9 ? { ...base, load, cores, rx, tx } : base];
  });
}

/** Peak per `n` equal time slots ending at `to` (max keeps short spikes); null where no samples:
 *  server off or no history kept. */
export function buckets(
  samples: Sample[],
  value: (s: Sample) => number | undefined,
  from: number,
  to: number,
  n: number,
): (number | null)[] {
  const out: (number | null)[] = Array(n).fill(null);
  const width = (to - from) / n;
  for (const s of samples) {
    const v = value(s);
    if (s.t < from || s.t > to || v === undefined) continue;
    const i = Math.min(n - 1, Math.floor((s.t - from) / width));
    out[i] = Math.max(out[i] ?? 0, v);
  }
  return out;
}

/** Fills gaps of up to `max` empty slots with value before, so once-a-minute history draws as
 *  line in shorter-slot chart. Longer gaps stay empty: server off or unreachable. */
export function bridge(values: (number | null)[], max: number): (number | null)[] {
  const out = [...values];
  let last = -1; // last filled index
  out.forEach((v, i) => {
    if (v === null) return;
    if (last >= 0 && i - last - 1 <= max) out.fill(out[last]!, last + 1, i);
    last = i;
  });
  return out;
}
