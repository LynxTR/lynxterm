import { invoke } from "@tauri-apps/api/core";
import type { SessionState, SshTarget } from "~/components/SshTerminal.vue";

// Open terminals, shared by tab strip (app.vue), terminal area (SessionsView) and host list.
// Tab holds one pane, or two side by side after split.
type Pane = { key: number; target: SshTarget; state: SessionState; session?: number };
export type Tab = { key: number; panes: Pane[] };

const tabs = ref<Tab[]>([]);
/** null is Home. */
const current = ref<number | null>(null);
const focusedPane = ref<number | null>(null);
let nextKey = 0;

const activeTab = computed(() => tabs.value.find((t) => t.key === current.value));
const activePane = computed(
  () =>
    activeTab.value?.panes.find((p) => p.key === focusedPane.value) ?? activeTab.value?.panes[0],
);
/** Open terminal session to host; Details uses it instead of own. */
const sessionFor = (h: { user: string; host: string; port: number }) =>
  tabs.value
    .flatMap((t) => t.panes)
    .find((p) => p.session !== undefined && hostKey(p.target) === hostKey(h))?.session;

const pane = (target: SshTarget): Pane => ({
  key: nextKey++,
  target: { ...target },
  state: "connecting",
});

function start(target: SshTarget) {
  const tab = { key: nextKey++, panes: [pane(target)] };
  tabs.value.push(tab);
  current.value = tab.key;
  focusedPane.value = tab.panes[0]!.key;
}

function closeTab(key: number) {
  tabs.value = tabs.value.filter((t) => t.key !== key);
  if (current.value === key) current.value = tabs.value.at(-1)?.key ?? null;
}

function closePane(tab: Tab, key: number) {
  tab.panes = tab.panes.filter((p) => p.key !== key);
  if (!tab.panes.length) closeTab(tab.key);
}

const isSplit = computed(() => (activeTab.value?.panes.length ?? 0) > 1);
function toggleSplit() {
  const tab = activeTab.value;
  if (!tab || !activePane.value) return;
  if (isSplit.value) return closePane(tab, tab.panes.at(-1)!.key);
  const second = pane(activePane.value.target);
  tab.panes.push(second);
  focusedPane.value = second.key;
}

const connect = (h: SavedHost) => start({ ...h, password: "" });
/** New tab running `command` instead of a shell, titled `what` after host; its pane, to
 *  follow. */
function runOn(h: SavedHost, command: string, what: string) {
  start({ ...h, name: `${hostName(h)}: ${what}`, password: "", command });
  return tabs.value.at(-1)!.panes[0]!;
}

// Tool panel beside terminals (SessionsView), one at a time.
type Panel = "sftp" | "monitor" | "snippets" | "forwards";
const panel = ref<Panel | null>(null);
function openFiles(h: SavedHost) {
  connect(h);
  panel.value = "sftp";
}

function runSnippet(s: { name: string; command: string }) {
  const pane = activePane.value;
  if (pane?.session === undefined) return;
  invoke("ssh_write", { id: pane.session, data: `${s.command}\r` });
  logActivity(pane.target, { kind: "snippet", title: `Ran snippet ${s.name}`, detail: s.command });
}

/** Unmounting terminals closes their sessions. */
function closeAll() {
  tabs.value = [];
  current.value = null;
}

export const useSessions = () => ({
  tabs,
  runOn,
  current,
  focusedPane,
  activePane,
  sessionFor,
  connect,
  openFiles,
  panel,
  runSnippet,
  closeTab,
  closePane,
  isSplit,
  toggleSplit,
  closeAll,
});
