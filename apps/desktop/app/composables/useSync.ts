import { invoke } from "@tauri-apps/api/core";
import { formatTimeAgo, useLocalStorage } from "@vueuse/core";

/** Groups and port forwards point at hosts, so travel with them. */
export const SYNC_SECTIONS = [
  {
    id: "hosts",
    label: "Hosts & keys",
    hint: "With groups and port forwards",
    kinds: ["host", "key", "group", "forward"],
  },
  { id: "snippets", label: "Snippets", hint: "", kinds: ["snippet"] },
  { id: "services", label: "Services", hint: "", kinds: ["service"] },
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
const skipped = ref<string[]>([]);
const lastSync = ref<number | null>(null);
const error = ref("");
/** Must match SIGNED_OUT in sync.rs. Another device changed master password: Worker dropped
 *  this device's sign-in until it signs in again with new one. */
const SIGNED_OUT = "Signed out: the master password was changed on another device";
const signedOut = ref(false);
const busy = ref(false);
const now = ref(Date.now());
/** Sign-ins on Worker so far, not unique devices: rejoin counts twice. */
const devices = ref(0);
/** Worker still takes new devices (no NEW_DEVICES = off); null until known. */
const newDevices = ref<boolean | null>(null);
const newDevicesOpen = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

// Kept across restarts so daily means daily.
const nextAt = useLocalStorage<Partial<Record<Section["id"], number>>>("lynxterm:syncNext", {});

const isOff = (s: Section) => s.kinds.every((k) => skipped.value.includes(k));
export const SYNC_EVERY = [
  { label: "Every 5 minutes", value: 5 },
  { label: "Every 15 minutes", value: 15 },
  { label: "Every hour", value: 60 },
  { label: "Daily", value: 1440 },
  { label: "Weekly", value: 10080 },
];
const every = (s: Section) => (useSettings().syncEvery as Record<string, number>)[s.id] ?? 60;
const isDue = (s: Section) => !isOff(s) && Date.now() >= (nextAt.value[s.id] ?? 0);

// Capture: xterm stops keydown bubbling, so useIdle misses terminal typing.
let lastInput = Date.now();
const markActive = () => (lastInput = Date.now());
addEventListener("keydown", markActive, { capture: true, passive: true });
addEventListener("pointerdown", markActive, { capture: true, passive: true });
const active = () => document.hasFocus() && Date.now() - lastInput < 15 * 60_000;

const reload = () =>
  Promise.all([
    useKeys().refresh(),
    useHosts().refresh(),
    useGroups().refresh(),
    useSnippets().refresh(),
    useServices().refresh(),
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
    actions: [
      { label: "Show me how", color: "primary", onClick: () => (newDevicesOpen.value = true) },
    ],
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

const signIn = (password: string) =>
  run(() => invoke("sync_sign_in", { password }).then(() => true));

/** Turning one back on pulls what it missed. */
async function setSkipped(kinds: string[]) {
  const added = skipped.value.some((k) => !kinds.includes(k));
  await invoke("sync_skip", { kinds });
  skipped.value = kinds;
  if (added) await syncNow();
}

async function setEvery(s: Section, minutes: number) {
  if (minutes) {
    useSettings().syncEvery[s.id] = minutes;
    nextAt.value[s.id] = Math.min(nextAt.value[s.id] ?? 0, Date.now() + minutes * MINUTE);
  }
  const others = skipped.value.filter((k) => !(s.kinds as readonly string[]).includes(k));
  if (minutes && isOff(s)) await setSkipped(others);
  else if (!minutes) await setSkipped([...others, ...s.kinds]);
}

function nextIn(s: Section) {
  const ms = (nextAt.value[s.id] ?? 0) - now.value;
  return ms <= 0 ? "now" : formatTimeAgo(new Date(now.value + Math.max(ms, MINUTE)), {}, now.value);
}

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

const ago = computed(() =>
  lastSync.value ? formatTimeAgo(new Date(lastSync.value), {}, now.value) : "not yet",
);

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
