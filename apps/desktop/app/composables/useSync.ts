import { invoke } from "@tauri-apps/api/core";
import { useLocalStorage } from "@vueuse/core";

/** Each section on own schedule. Groups and port forwards point at hosts, so travel with them. */
export const SYNC_SECTIONS = [
  {
    id: "hosts",
    label: "Hosts & keys",
    hint: "With groups and port forwards",
    kinds: ["host", "key", "group", "forward"],
  },
  { id: "snippets", label: "Snippets", hint: "", kinds: ["snippet"] },
  { id: "history", label: "Command history", hint: "", kinds: ["history"] },
  {
    id: "activity",
    label: "Server activity",
    hint: "Snippets run, keys installed, files moved",
    kinds: ["activity"],
  },
] as const;
type Section = (typeof SYNC_SECTIONS)[number];

const MINUTE = 60_000;
const url = ref<string | null>(null);
/** Item kinds this device keeps to itself: sections turned off. */
const skipped = ref<string[]>([]);
const lastSync = ref<number | null>(null);
const error = ref("");
/** Must match SIGNED_OUT in sync.rs. Another device changed master password: Worker dropped
 *  this device's sign-in until it signs in again with new one. */
const SIGNED_OUT = "Signed out: the master password was changed on another device";
const signedOut = ref(false);
const busy = ref(false);
const now = ref(Date.now());
/** Sign-ins on Worker so far. */
const devices = ref(0);
/** Worker still takes new devices (no NEW_DEVICES = off); null until known. */
const newDevices = ref<boolean | null>(null);
const newDevicesOpen = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

// Each section's next turn. Kept across restarts so daily means daily.
const nextAt = useLocalStorage<Partial<Record<Section["id"], number>>>("lynxterm:syncNext", {});

const isOff = (s: Section) => s.kinds.every((k) => skipped.value.includes(k));
// Sections added later: hourly until picked.
const every = (s: Section) => (useSettings().syncEvery as Record<string, number>)[s.id] ?? 60;
const isDue = (s: Section) => !isOff(s) && Date.now() >= (nextAt.value[s.id] ?? 0);

// Ask Worker for changes only while app in use: focused, key press or click in last 15 minutes.
const IDLE_AFTER = 15 * 60_000;
let lastInput = Date.now();
const markActive = () => (lastInput = Date.now());
addEventListener("keydown", markActive, { capture: true, passive: true });
addEventListener("pointerdown", markActive, { capture: true, passive: true });
const active = () => document.hasFocus() && Date.now() - lastInput < IDLE_AFTER;

/** Reloads every synced list from vault. */
const reload = () =>
  Promise.all([
    useKeys().refresh(),
    useHosts().refresh(),
    useGroups().refresh(),
    useSnippets().refresh(),
    useForwards().refresh(),
    useHistory().load(),
  ]);

async function run(fn: () => Promise<boolean>) {
  busy.value = true;
  try {
    const changed = await fn();
    lastSync.value = now.value = Date.now();
    error.value = "";
    signedOut.value = false;
    if (changed) await reload();
  } catch (e) {
    // Signed out stays until sign-in works; wrong password meanwhile shows as error.
    if (String(e) === SIGNED_OUT) signedOut.value = true;
    error.value = String(e) === SIGNED_OUT ? "" : String(e);
  } finally {
    busy.value = false;
  }
}

/** One request: pulls every synced section, sends `sections`' local changes. */
async function syncSections(sections: readonly Section[]) {
  const at = Date.now();
  // On failure retry within 5 minutes; on success wait full turn.
  for (const s of sections) nextAt.value[s.id] = at + Math.min(every(s), 5) * MINUTE;
  await run(async () => {
    const send = sections.flatMap((s) => s.kinds);
    const changed = await invoke<boolean>("sync_now", { send });
    for (const s of sections) nextAt.value[s.id] = at + every(s) * MINUTE;
    return changed;
  });
}

const syncNow = () => syncSections(SYNC_SECTIONS.filter((s) => !isOff(s)));

async function refreshStatus() {
  const status = await invoke<{ devices: number; newDevices: boolean }>("sync_status").catch(
    () => null,
  );
  if (!status) return;
  devices.value = status.devices;
  newDevices.value = status.newDevices;
}

async function remindNewDevices() {
  await refreshStatus();
  if (!newDevices.value || devices.value < 2) return;
  useToast().add({
    title: "Is that all your devices?",
    description: "Then turn off new devices, so nobody else can sign in to your Worker.",
    icon: "i-ph-shield-check-duotone",
    duration: 30_000,
    actions: [{ label: "Show me how", onClick: () => (newDevicesOpen.value = true) }],
  });
}

async function connect(form: { url: string; enrollToken: string; password: string }) {
  await run(async () => {
    await invoke("sync_connect", form);
    url.value = await invoke<string | null>("sync_url");
    skipped.value = [];
    return true;
  });
  if (!error.value) remindNewDevices();
}

/** After another device changed master password: sign in with new one. */
const signIn = (password: string) =>
  run(() => invoke("sync_sign_in", { password }).then(() => true));

/** Keeps `kinds` on this device. Turning one back on pulls what it missed. */
async function setSkipped(kinds: string[]) {
  const added = skipped.value.some((k) => !kinds.includes(k));
  await invoke("sync_skip", { kinds });
  skipped.value = kinds;
  if (added) await syncNow();
}

/** Minutes between section's turns; 0 turns it off. */
async function setEvery(s: Section, minutes: number) {
  if (minutes) {
    useSettings().syncEvery[s.id] = minutes;
    nextAt.value[s.id] = Math.min(nextAt.value[s.id] ?? 0, Date.now() + minutes * MINUTE);
  }
  const others = skipped.value.filter((k) => !(s.kinds as readonly string[]).includes(k));
  if (minutes && isOff(s)) await setSkipped(others);
  else if (!minutes) await setSkipped([...others, ...s.kinds]);
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
/** "in 4 minutes", "3 hours ago", "yesterday": `ms` from now, negative for past. */
export function fromNow(ms: number) {
  const minutes = Math.round(ms / MINUTE);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  if (Math.abs(minutes) < 24 * 60) return relative.format(Math.round(minutes / 60), "hour");
  return relative.format(Math.round(minutes / 1440), "day");
}

function nextIn(s: Section) {
  const ms = (nextAt.value[s.id] ?? 0) - now.value;
  return ms <= 0 ? "now" : fromNow(Math.max(ms, MINUTE));
}

// Asks Worker only when a section is due. Idle or in background, goes out only to send
// changes; finding those is local.
async function tick() {
  now.value = Date.now();
  if (!url.value || busy.value || signedOut.value) return;
  const due = SYNC_SECTIONS.filter(isDue);
  if (!due.length) return;
  if (!active()) {
    const pending = await invoke<string[]>("sync_pending");
    if (!due.some((s) => s.kinds.some((k) => pending.includes(k)))) return;
  }
  await syncSections(due);
}

// Returning counts as activity: section that came due meanwhile syncs at once. While new
// devices allowed, also checks if turned off on Cloudflare, so warning clears by itself.
addEventListener("focus", () => {
  markActive();
  tick();
  if (newDevices.value) refreshStatus();
});

async function start() {
  timer ??= setInterval(tick, 30_000);
  url.value = await invoke<string | null>("sync_url");
  if (!url.value) return;
  skipped.value = await invoke<string[]>("sync_skipped");
  syncSections(SYNC_SECTIONS.filter(isDue));
  refreshStatus();
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  url.value = lastSync.value = newDevices.value = null;
  skipped.value = [];
  error.value = "";
  signedOut.value = false;
  devices.value = 0;
}

const state = computed(() => {
  if (!url.value) return "off";
  if (busy.value) return "busy";
  if (signedOut.value) return "signedOut";
  if (error.value) return "error";
  return "ok";
});

const ago = computed(() => {
  if (!lastSync.value) return "not yet";
  const ms = lastSync.value - now.value;
  return ms > -MINUTE ? "just now" : fromNow(ms);
});

const host = computed(() => url.value?.replace(/^https?:\/\//, "") ?? "");

export const useSync = () => ({
  url,
  skipped,
  isOff,
  every,
  setEvery,
  nextIn,
  host,
  error,
  signedOut,
  busy,
  state,
  ago,
  syncNow,
  connect,
  signIn,
  devices,
  newDevices,
  newDevicesOpen,
  refreshStatus,
  remindNewDevices,
  reload,
  start,
  stop,
});
