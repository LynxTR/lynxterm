<script setup lang="ts">
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { useDebounceFn, useResizeObserver } from "@vueuse/core";
import "@xterm/xterm/css/xterm.css";
import { Channel, invoke } from "@tauri-apps/api/core";
import hooks from "../../src-tauri/src/shell-integration.sh?raw";
import sessionHooks from "../../src-tauri/src/shell-integration-session.sh?raw";

export interface SshTarget {
  name?: string;
  group?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  keyId: string;
  command?: string;
}

export type SessionState = "connecting" | "open" | "closed";

const props = defineProps<{ target: SshTarget; closable?: boolean }>();
const emit = defineEmits<{
  state: [SessionState];
  session: [number];
  focus: [];
  close: [];
}>();
const el = useTemplateRef("el");
const scroller = useTemplateRef("scroller");
const error = ref("");
const unknownHost = ref("");
const state = ref<SessionState>("connecting");
const toast = useToast();

watch(state, (s) => emit("state", s), { immediate: true });

function token(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

const term = new Terminal({
  fontFamily: '"JetBrains Mono", "Symbols Nerd Font Mono", monospace',
  fontSize: 13,
  lineHeight: 1.5,
  // Own caret drawn; xterm's kept invisible for cell math.
  cursorStyle: "bar",
  cursorInactiveStyle: "none",
  scrollback: 10_000,
  theme: {
    background: token("--ui-bg", "#0b0d10"),
    foreground: FOREGROUND,
    cursor: "#00000000",
    selectionBackground: `${token("--ui-primary", "#ffb020")}40`,
    ...ANSI,
    scrollbarSliderBackground: "#ffffff14",
    scrollbarSliderHoverBackground: "#ffffff26",
    scrollbarSliderActiveBackground: "#ffffff33",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
// Fit once open and resize settled: each fit resizes server, shell redraws.
useResizeObserver(
  el,
  useDebounceFn(() => term.element && fit.fit(), 120),
);
let id: number | undefined;

// With shell integration, shell marks command line start (OSC 133): read exact line from
// screen. Without it, follow keystrokes; give up when shell edits line out of sight.
const { record, suggest } = useHistory();
const historyKey = hostKey(props.target);
const commands = ref<string[]>([]);
const integrated = ref(false);
const cwd = ref("");
const ghost = reactive({
  line: "",
  list: [] as Completion[],
  pick: 0,
  open: true,
  below: true,
  left: 0,
  top: 0,
});
const rest = computed(() => {
  const full = ghost.list[ghost.pick]?.text ?? "";
  const typed = ghost.line + pending.text;
  return full.startsWith(typed) ? full.slice(typed.length) : "";
});
const menu = computed(() => ghost.open && ghost.list.length > 1);
const word = computed(() => ghost.line.slice(ghost.line.lastIndexOf(" ") + 1));
let promptStart: { x: number; y: number } | null = null; // absolute cell after prompt
let typed = "";
let stale = false;

function readLine(start: { x: number; y: number }, toCursor = false) {
  const b = term.buffer.active;
  const cursorY = b.baseY + b.cursorY;
  let text = "";
  for (let y = start.y; y < b.length; y++) {
    const line = b.getLine(y);
    if (!line || (y > start.y && !line.isWrapped)) break;
    const last = toCursor && y === cursorY;
    text += line.translateToString(
      false,
      y === start.y ? start.x : 0,
      last ? b.cursorX : undefined,
    );
    if (last) break;
  }
  return toCursor ? text : text.trimEnd();
}

const settings = useSettings();
const plain = settings.terminalStyle !== "blocks";
term.parser.registerOscHandler(133, (data) => {
  // Markers before our own setup: hooks are in server's shell files.
  if (setup !== "done" && !settings.integratedHosts.includes(historyKey))
    settings.integratedHosts.push(historyKey);
  integrated.value = true;
  const b = term.buffer.active;
  const l = live.value;
  if (data[0] === "A") {
    // Fresh prompt only: redraws (resize, Ctrl+L, Tab) get no D first.
    if (!fresh) return true;
    if (b.type === "normal" && !plain) freeze();
    reveal();
    live.value = { at: mark(), branch: gitBranch, cwd: cwd.value };
    fresh = false;
  } else if (data[0] === "B") promptStart = { x: b.cursorX, y: b.baseY + b.cursorY };
  else if (data[0] === "C") {
    const command = promptStart ? readLine(promptStart) : "";
    if (command) record(historyKey, command);
    // cursor on first output line
    Object.assign(l, { ran: true, command, start: Date.now(), out: mark() });
    promptStart = null;
  } else {
    // "D;1": command just ended, with exit status
    if (data.startsWith("D;") && l.ran && l.status === undefined)
      Object.assign(l, { status: Number(data.slice(2)), ms: Date.now() - l.start! });
    fresh = true;
    promptStart = null;
  }
  return true;
});
term.parser.registerOscHandler(7, (data) => {
  try {
    cwd.value = decodeURIComponent(new URL(data).pathname);
  } catch {}
  return true;
});

interface Card {
  id: number;
  html: string[]; // wrapped rows rejoined: cards reflow
  text: string[];
  outAt: number;
  command?: string; // undefined: login/server message, no header
  status?: number;
  ms?: number;
  start?: number;
  branch: string;
  cwd: string;
}
interface Live {
  at?: IMarker;
  out?: IMarker;
  ran?: boolean;
  command?: string;
  start?: number;
  status?: number;
  ms?: number;
  cleared?: boolean;
  branch: string;
  cwd: string;
}
// ponytail: count cap; cap by total lines if huge outputs hog memory
const MAX_CARDS = 300;
const cards = shallowRef<Card[]>([]);
const live = ref<Live>({ branch: "", cwd: "" });
let fresh = true; // D seen since last A: shell drawing new prompt
let nextCard = 0;
const mark = () => markRaw(term.registerMarker(0));
const scratch = term.buffer.normal.getNullCell();
let gitBranch = "";
const alternate = ref(false);
term.buffer.onBufferChange((b) => {
  alternate.value = b.type === "alternate";
  measure();
});

term.parser.registerOscHandler(633, (data) => {
  if (data.startsWith("P;Branch=")) gitBranch = data.slice(9);
  return true;
});

// `clear`, Ctrl+L: cards go too.
term.parser.registerCsiHandler({ final: "J" }, (params) => {
  if ((params[0] === 2 || params[0] === 3) && term.buffer.active.type === "normal") {
    cards.value = [];
    if (live.value.ran) live.value.cleared = true;
  }
  return false; // terminal still clears
});

function freeze() {
  const b = term.buffer.normal;
  const l = live.value;
  const cursor = b.baseY + b.cursorY;
  const outRow = l.out?.line ?? -1;
  const inputRow = promptStart?.y ?? -1;
  const { command, status, ms, start, branch } = l;
  const card: Card = {
    ...{ id: nextCard++, html: [], text: [], outAt: -1 },
    ...{ command, status, ms, start, branch, cwd: l.cwd },
  };
  let extra = false;
  // Marker trimmed off scrollback: line -1, start at top.
  for (let y = Math.max(l.at?.line ?? 0, 0); y < cursor; y++) {
    const line = b.getLine(y)!;
    const trim = !b.getLine(y + 1)?.isWrapped;
    const [html, text] = [rowHtml(line, scratch, trim), line.translateToString(trim)];
    if (line.isWrapped && card.html.length) {
      card.html[card.html.length - 1] += html;
      card.text[card.text.length - 1] += text;
      continue;
    }
    if (y === outRow) card.outAt = card.html.length;
    if (inputRow >= 0 && y > inputRow && text.trim()) extra = true;
    card.html.push(html);
    card.text.push(text);
  }
  while (card.text.length && !card.text.at(-1)!.trim()) (card.html.pop(), card.text.pop());
  if (card.outAt < 0) card.outAt = card.text.length;
  // Empty Enter, Ctrl+C: drop. Login (no prompt yet): keep.
  const keep = l.ran ? !l.cleared : card.text.length && (!l.at || extra);
  if (keep) cards.value = [...cards.value, card].slice(-MAX_CARDS);
  term.clear();
}

/** `gap`: cell minus glyph width; overlays and cards letter-space by it to stay on grid. */
const view = reactive({ y: 0, rowHeight: 0, cellWidth: 0, gap: 0, used: 0 });
function usedRows() {
  const b = term.buffer.active;
  if (plain || b.type === "alternate" || b.baseY > 0) return term.rows;
  for (let y = term.rows - 1; y > b.cursorY; y--)
    if (b.getLine(y)?.translateToString(true)) return y + 1;
  return b.cursorY + 1;
}
// Cell size: screen box changes with it (resize, zoom, renderer swap). Observed, not read
// on every write.
const screen = shallowRef<HTMLElement | null>(null);
let glyph = 0;
useResizeObserver(screen, ([e]) => {
  view.rowHeight = e!.contentRect.height / term.rows;
  view.cellWidth = e!.contentRect.width / term.cols;
  view.gap = view.cellWidth - glyph;
});
/** Overlay at cell x, y (buffer row): on terminal's grid. */
const cellStyle = (x: number, y: number) => ({
  left: `${x * view.cellWidth}px`,
  top: `${(y - view.y) * view.rowHeight}px`,
  lineHeight: `${view.rowHeight}px`,
  letterSpacing: `${view.gap}px`,
});
function measure() {
  view.y = term.buffer.active.viewportY;
  view.used = usedRows();
}
term.onScroll(measure);
term.onResize(measure);
term.onWriteParsed(measure); // xterm stops painting while scrolled out of view

// Scroll anchoring off: it moved scroll as cards settled, read as user scroll.
let stick = true;
const onScroll = () => {
  const s = scroller.value!;
  stick = s.scrollHeight - s.scrollTop - s.clientHeight < 8;
};
const follow = () =>
  stick &&
  nextTick(() => scroller.value && (scroller.value.scrollTop = scroller.value.scrollHeight));

// Growth at bottom (cards, lazy card height, rows) keeps prompt in view.
const content = useTemplateRef("content");
useResizeObserver(content, follow);
/** Rows fill scroller minus padding (blocks: header, border). */
const paneHeight = ref(0);
const fitPane = () =>
  scroller.value && (paneHeight.value = scroller.value.clientHeight - (plain ? 24 : 62));
useResizeObserver(scroller, fitPane);
const refocus = () => getSelection()?.toString() || term.focus();

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const copy = (text: string, what: string) =>
  copyText(text, `Copied the ${what}`).then(() => term.focus());

function took(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const SETUP = (() => {
  // Comments stay out of typed line, except first: session script looks for it in history.
  const script = `${hooks}\n${sessionHooks}`
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) || l.startsWith("# >>>"))
    .join("\n");
  // Only bash and zsh run it; other shells fail the test.
  return ` [ -n "$BASH_VERSION$ZSH_VERSION" ] && eval "$(printf %s '${btoa(script)}' | base64 -d)"\r`;
})();
let setup: "wait" | "hidden" | "done" =
  settings.terminalStyle !== "raw" && !props.target.command ? "wait" : "done";
let timer: ReturnType<typeof setTimeout> | undefined;
let held = "";
let typedAhead = "";
const decoder = new TextDecoder();
const offer = ref(false);

function cursorKind() {
  const b = term.buffer.active;
  return lineKind(b.getLine(b.baseY + b.cursorY)?.translateToString(false, 0, b.cursorX) ?? "");
}

function startSetup() {
  if (setup !== "wait" || state.value === "closed") return;
  // Prompt leaves cursor after it; at column 0 login still printing.
  if (id === undefined || term.buffer.active.cursorX === 0)
    return void (timer = setTimeout(startSetup, 400));
  const kind = cursorKind();
  // Login asks (Hetzner password change): show now. Setup retries on more output.
  if (kind === "asking") return reveal();
  if (kind === "unsure") return void ((setup = "done"), (offer.value = true), reveal());
  typeSetup();
}

function typeSetup(prefix = "") {
  offer.value = false;
  setup = "hidden";
  invoke("ssh_write", { id, data: prefix + SETUP });
  timer = setTimeout(() => finishSetup(held), 3000); // not bash or zsh: show all
}

function finishSetup(rest: string, promptLines?: number) {
  clearTimeout(timer);
  setup = "done";
  held = "";
  // Erase prompt hooked one replaces; cursor still at its end.
  const erase =
    promptLines === undefined ? "" : `${promptLines ? `\x1b[${promptLines}A` : ""}\r\x1b[J`;
  term.write(erase + rest);
  if (promptLines === undefined) reveal(); // not bash or zsh: no prompt marker coming
  if (typedAhead) send(typedAhead);
  typedAhead = "";
}

// Host card stays up during login output (else rows grow, then jump into card): until first
// prompt, login question, or 4s.
const ready = ref(false);
let readyTimer: ReturnType<typeof setTimeout> | undefined;
function reveal() {
  clearTimeout(readyTimer);
  ready.value = true;
}
const revealIn = (ms: number) => {
  if (ready.value) return;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(reveal, ms);
};

function receive(bytes: Uint8Array) {
  if (setup !== "hidden") {
    term.write(bytes);
    if (setup === "done") revealIn(400);
    // Wait for shell to go quiet: that is when it shows first prompt.
    if (setup === "wait") {
      clearTimeout(timer);
      timer = setTimeout(startSetup, 400);
    }
    return;
  }
  held += decoder.decode(bytes, { stream: true });
  const done = /\x1b\]633;Ready;(\d+)\x07/.exec(held);
  if (done) finishSetup(held.slice(done.index + done[0].length), Number(done[1]));
}

/** `text` echoed on cursor line? Password prompts don't echo, so never saved. */
function echoed(text: string) {
  const b = term.buffer.active;
  let y = b.baseY + b.cursorY;
  let shown = b.getLine(y)?.translateToString(true) ?? "";
  while (y > 0 && b.getLine(y)?.isWrapped)
    shown = (b.getLine(--y)?.translateToString() ?? "") + shown;
  return shown.trimEnd().endsWith(text.trimEnd());
}

function track(data: string) {
  if (integrated.value) return;
  if (term.buffer.active.type === "alternate") return void (stale = true);
  const printable = [...data].every((c) => c >= " " && c !== "\x7f");
  if (data === "\r") {
    if (!stale && typed && echoed(typed)) record(historyKey, typed);
    typed = "";
    stale = false;
  } else if (data === "\x7f" || data === "\b") {
    typed = typed.slice(0, -1);
  } else if (data === "\x03" || data === "\x15") {
    typed = "";
    stale = false;
  } else if (printable) {
    typed += data;
  } else {
    stale = true;
  }
}

function currentLine(): string | null {
  const b = term.buffer.active;
  if (b.type === "alternate" || b.viewportY !== b.baseY) return null;
  if (!integrated.value) return stale ? null : typed;
  if (!promptStart) return null;
  const upToCursor = readLine(promptStart, true);
  // cursor at end only; trailing spaces count as end
  return upToCursor.trimEnd() === readLine(promptStart) ? upToCursor : null;
}

function updateGhost() {
  const line = currentLine() ?? "";
  if (line !== ghost.line) Object.assign(ghost, { line, pick: 0, open: true });
  const found = [
    ...suggest(historyKey, line, commands.value).map((text) => ({ text })),
    ...figComplete(line, updateGhost),
  ];
  ghost.list = found.filter((c, i) => found.findIndex((o) => o.text === c.text) === i).slice(0, 8);
  if (!ghost.list.length || !screen.value) return;
  const b = term.buffer.active;
  ghost.left = b.cursorX * view.cellWidth;
  ghost.top = b.cursorY * view.rowHeight;
  const box = scroller.value?.getBoundingClientRect();
  ghost.below =
    !box || screen.value.getBoundingClientRect().top + ghost.top - box.top < box.height / 2;
}

function accept(i = ghost.pick) {
  const text = ghost.list[i]?.text.slice(ghost.line.length + pending.text.length);
  if (!text || id === undefined) return;
  ghost.list = [];
  if (!integrated.value) typed += text;
  invoke("ssh_write", { id, data: text });
  term.focus();
}

let anchor: number | null = null;
let head = 0;
const SELECT_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];
function selectByKey(e: KeyboardEvent) {
  const b = term.buffer.active;
  const cursor = { x: b.cursorX, y: b.baseY + b.cursorY };
  // Hooks: prompt only (running program may want keys). None: cursor row.
  const start = promptStart ?? (integrated.value ? null : { x: 0, y: cursor.y });
  if (!start || b.type === "alternate") return false;
  const text = readLine(start);
  if (anchor === null || !term.hasSelection()) {
    const at = (cursor.y - start.y) * term.cols + cursor.x - start.x;
    anchor = head = Math.min(Math.max(at, 0), text.length);
  }
  head = moveHead(text, head, e.key, e.ctrlKey);
  const from = start.x + Math.min(anchor, head);
  const length = Math.abs(head - anchor);
  if (length) term.select(from % term.cols, start.y + Math.floor(from / term.cols), length);
  else term.clearSelection();
  return true;
}

term.attachCustomKeyEventHandler((e) => {
  const normal = term.buffer.active.type === "normal";
  // Paste via webview paste event (xterm takes it). Ctrl+V stays vim's in full-screen apps.
  const paste = e.ctrlKey && !e.altKey && !e.metaKey && e.code === "KeyV" && (e.shiftKey || normal);
  if (e.type !== "keydown") return !paste;
  // Typing: setup now lands mid-line. Login answers fine. Not onData: xterm answers server
  // queries through it.
  if (setup === "wait" && cursorKind() !== "asking") {
    setup = "done";
    clearTimeout(timer);
    reveal();
  }
  if (e.ctrlKey && e.code === "KeyC" && (e.shiftKey || term.hasSelection())) {
    const text = term.getSelection() || getSelection()?.toString();
    if (text) copyText(text, "Copied");
    term.clearSelection();
    return false;
  }
  if (e.shiftKey && !e.altKey && !e.metaKey && SELECT_KEYS.includes(e.key)) {
    if (selectByKey(e)) {
      e.preventDefault();
      return false;
    }
  } else if (!["Shift", "Control"].includes(e.key)) anchor = null;
  const shell = normal ? shellKey(e) : undefined;
  if (shell) {
    e.preventDefault();
    term.input(shell);
    return false;
  }
  if (paste) return false;
  const bare = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (!bare || !rest.value) return true;
  const n = ghost.list.length;
  if (e.key === "ArrowRight") accept();
  else if (menu.value && e.key === "ArrowDown") ghost.pick = (ghost.pick + 1) % n;
  else if (menu.value && e.key === "ArrowUp") ghost.pick = (ghost.pick + n - 1) % n;
  else if (menu.value && e.key === "Escape") ghost.open = false;
  else return true;
  return false;
});

function onData(buf: ArrayBuffer) {
  if (buf.byteLength) return receive(new Uint8Array(buf));
  // Empty frame: session ended.
  if (setup === "hidden") finishSetup(held);
  reveal();
  offer.value = false;
  term.write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
  state.value = "closed";
}
function send(data: string) {
  track(data);
  invoke("ssh_write", { id, data });
}

const pending = reactive(echoState());
const echo = localEcho(
  {
    get cols() {
      return term.cols;
    },
    cursor: () => {
      const b = term.buffer.active;
      return { x: b.cursorX, y: b.baseY + b.cursorY };
    },
    cell: (x, y) => term.buffer.active.getLine(y)?.getCell(x)?.getChars() ?? "",
    restBlank: () => {
      const b = term.buffer.active;
      return !b.getLine(b.baseY + b.cursorY)?.translateToString(true, b.cursorX);
    },
    unsafe: () => !settings.localEcho || alternate.value || cursorKind() === "asking",
  },
  pending,
);
const echoing = computed(echo.visible);
const waiting = computed(echo.waiting);

const caret = reactive({ x: 0, y: 0, glide: false, idle: false, hidden: false, focused: false });
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function placeCaret() {
  const b = term.buffer.active;
  const [x, y] = echoing.value
    ? [pending.x + pending.text.length, pending.y]
    : [b.cursorX, b.baseY + b.cursorY];
  if (x === caret.x && y === caret.y) return;
  Object.assign(caret, { glide: y === caret.y, x, y, idle: false });
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => (caret.idle = true), 600);
}
// DECTCEM hide (htop); xterm handles it too.
const dectcem = (hidden: boolean) => (params: (number | number[])[]) => {
  if (params.includes(25)) caret.hidden = hidden;
  return false;
};
term.parser.registerCsiHandler({ prefix: "?", final: "h" }, dectcem(false));
term.parser.registerCsiHandler({ prefix: "?", final: "l" }, dectcem(true));

// Overlays move after xterm paints: else text and cursor disagree a frame (jitter typing fast).
term.onRender(() => {
  echo.settle();
  placeCaret();
  updateGhost();
  measure();
  follow();
});

term.onData((data) => {
  if (id === undefined) return;
  if (setup === "hidden") return void (typedAhead += data);
  echo.key(data);
  placeCaret();
  stick = true;
  send(data);
});
term.onResize(({ cols, rows }) => {
  if (id !== undefined) invoke("ssh_resize", { id, cols, rows });
});

const { hosts, refresh: refreshHosts } = useHosts();
const saved = computed(() => hosts.value.find((h) => hostKey(h) === historyKey));
const password = ref(props.target.password);
const remember = ref(true);
const askPassword = ref(false);

const opened = ref(false);
const gate = computed(
  () => !opened.value && (askPassword.value || !!unknownHost.value || !!error.value),
);
const cover = computed(() => gate.value || !ready.value);

async function open(trust?: string) {
  error.value = unknownHost.value = "";
  state.value = "connecting";
  try {
    id = await invoke<number>("ssh_open", {
      ...props.target,
      password: password.value,
      trust,
      cols: term.cols,
      rows: term.rows,
      // New channel each try: Tauri unregisters one once Rust drops it (failed open, ended
      // session), so a reused one gets nothing after trust or retry.
      onData: new Channel<ArrayBuffer>(onData),
    });
    if (password.value && remember.value && saved.value) {
      const { host, port, user } = props.target;
      invoke("host_password_save", { host, port, user, password: password.value })
        .then(refreshHosts)
        .catch((e) => toast.add({ title: "Couldn't save the password", description: String(e) }));
    }
    password.value = "";
    askPassword.value = false;
    opened.value = true;
    state.value = "open";
    revealIn(4000);
    emit("session", id);
    invoke<string[]>("ssh_commands", { id })
      .then((list) => (commands.value = list))
      .catch(() => {});
    term.focus();
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("unknown-host:")) unknownHost.value = msg.slice("unknown-host:".length);
    else if (msg === "Authentication failed" && !props.target.keyId) {
      // Saved one stale after password change on server.
      error.value = password.value ? "Wrong password" : "The saved password didn't work";
      password.value = "";
      askPassword.value = true;
    } else error.value = msg;
    state.value = "closed";
  }
}

function connect() {
  if (
    asksPassword({ ...props.target, savedPassword: saved.value?.savedPassword }) &&
    !password.value
  )
    return void ((askPassword.value = true), (state.value = "closed"));
  open();
}

onMounted(async () => {
  // xterm measures font once, on open
  await Promise.all([
    document.fonts.load('13px "JetBrains Mono"'),
    document.fonts.load('13px "Symbols Nerd Font Mono"', "\ue0b0"),
  ]);
  fitPane();
  await nextTick();
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
  glyph = ctx.measureText("W").width;
  term.open(el.value!);
  screen.value = el.value!.querySelector<HTMLElement>(".xterm-screen");
  // GPU renderer; xterm's DOM one when WebGL missing or lost (too many tabs, driver reset).
  // WebGL cells are whole device pixels rounded down (7.8px glyph: 7px, squeezed): letter
  // spacing rounds up instead. ponytail: set once; window moved to other display scale may be
  // a device pixel wide, re-set on resolution change if it shows.
  try {
    const gpu = new WebglAddon();
    gpu.onContextLoss(() => {
      gpu.dispose();
      term.options.letterSpacing = 0;
      fit.fit();
    });
    term.loadAddon(gpu);
    const px = glyph * devicePixelRatio;
    term.options.letterSpacing = Math.round(px) - Math.floor(px);
  } catch {}
  term.textarea?.addEventListener("focus", () => ((caret.focused = true), emit("focus")));
  term.textarea?.addEventListener("blur", () => (caret.focused = false));
  term.element?.addEventListener("mousedown", () => (anchor = null));
  fit.fit();
  measure();
  connect();
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(readyTimer);
  if (id !== undefined) invoke("ssh_close", { id });
  term.dispose();
});
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <!-- Card till shell ready; terminal laid out invisible underneath, keeps its size -->
    <Transition leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
      <div v-if="cover" class="absolute inset-0 z-20 grid animate-enter place-items-center p-6">
        <div class="flex w-full max-w-sm flex-col gap-4 card p-5">
          <div class="flex min-w-0 items-center gap-3">
            <HostLogo :os="saved?.os" />
            <div class="min-w-0">
              <div class="truncate font-medium">{{ hostName(target) }}</div>
              <div class="truncate font-mono text-xs text-muted">{{ hostLabel(target) }}</div>
            </div>
          </div>
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-ph-warning-circle-duotone"
            :title="error"
          />
          <template v-if="unknownHost">
            <p class="text-sm text-muted">
              First connection to this host. Trust it only if this key fingerprint matches the
              server's.
            </p>
            <code class="rounded-md bg-elevated px-2.5 py-2 font-mono text-xs break-all">
              {{ unknownHost }}
            </code>
            <UButton
              color="primary"
              label="Trust and connect"
              icon="i-ph-shield-check-duotone"
              class="self-end"
              :loading="state === 'connecting'"
              @click="open(unknownHost)"
            />
          </template>
          <form v-else-if="askPassword" class="flex flex-col gap-3" @submit.prevent="open()">
            <UInput
              v-model="password"
              type="password"
              required
              autofocus
              placeholder="Password"
              aria-label="SSH password"
              class="w-full"
            />
            <div class="flex items-center gap-3">
              <UCheckbox
                v-if="saved"
                v-model="remember"
                label="Save password"
                description="Encrypted in your vault, synced like keys."
              />
              <UButton
                color="primary"
                type="submit"
                label="Connect"
                icon="i-ph-terminal-duotone"
                class="ml-auto"
                :loading="state === 'connecting'"
              />
            </div>
          </form>
          <UButton
            color="primary"
            v-else-if="error"
            label="Try again"
            icon="i-ph-arrow-clockwise"
            class="self-end"
            :loading="state === 'connecting'"
            @click="connect()"
          />
          <div v-else class="hint">
            <UIcon name="i-ph-circle-notch" class="size-4 animate-spin text-primary" />
            {{ state === "connecting" ? "Connecting…" : "Starting shell…" }}
          </div>
        </div>
      </div>
    </Transition>
    <div v-if="offer && state === 'open' && !alternate" class="animate-enter px-4 pt-3">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-ph-rows-duotone"
        title="Turn on command blocks here?"
        description="Lynxterm couldn't spot a shell prompt, so it didn't type its setup line. Turn on only if a shell is waiting for a command."
        :actions="[
          { label: 'Turn on', color: 'primary', onClick: () => typeSetup('\x15') },
          { label: 'Not now', color: 'neutral', variant: 'ghost', onClick: () => (offer = false) },
        ]"
      />
    </div>
    <div
      ref="scroller"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 [overflow-anchor:none]"
      :class="cover ? 'invisible' : 'animate-fade'"
      :style="{ '--row': `${view.rowHeight || 24}px`, '--gap': `${view.gap}px` }"
      @scroll="onScroll"
      @mouseup="refocus"
    >
      <div ref="content" class="flex shrink-0 flex-col gap-2">
        <template v-if="!alternate">
          <section
            v-for="c in cards"
            :key="c.id"
            class="group shrink-0 card [contain-intrinsic-size:auto_96px] [content-visibility:auto]"
            :class="c.status && 'border-error/40'"
          >
            <header v-if="c.command !== undefined" class="card-head">
              <span v-if="c.status !== undefined" :class="c.status ? 'text-error' : 'text-success'">
                exit {{ c.status }}
              </span>
              <span v-if="(c.ms ?? 0) >= 1000">{{ took(c.ms!) }}</span>
              <span v-if="c.start">{{ clock(c.start) }}</span>
              <span v-if="c.cwd" class="truncate">{{ c.cwd }}</span>
              <span v-if="c.branch" class="flex min-w-0 items-center gap-1">
                <UIcon name="i-ph-git-branch-duotone" class="size-3.5 shrink-0" />
                <span class="truncate">{{ c.branch }}</span>
              </span>
              <span class="ml-auto hidden gap-3 group-hover:flex">
                <button class="hover:text-default" @click="copy(c.command, 'command')">
                  copy command
                </button>
                <button
                  v-if="c.outAt < c.text.length"
                  class="hover:text-default"
                  @click="copy(c.text.slice(c.outAt).join('\n'), 'output')"
                >
                  copy output
                </button>
              </span>
            </header>
            <!-- safe: rowHtml escapes text, styles its own -->
            <div
              class="lt-out px-3 pb-2"
              :class="c.command === undefined && 'pt-2'"
              v-html="c.html.join('\n')"
            />
          </section>
        </template>

        <section class="relative shrink-0" :class="!plain && 'card'">
          <UButton
            v-if="plain && closable"
            icon="i-ph-x"
            size="xs"
            variant="ghost"
            aria-label="Close this pane"
            class="absolute top-0 right-0 z-30"
            @click="emit('close')"
          />
          <header v-if="!plain" class="card-head">
            <span v-if="state === 'connecting'" class="text-primary">connecting…</span>
            <span v-else-if="state === 'closed'">disconnected</span>
            <span v-else-if="live.ran && live.status === undefined" class="text-primary">
              running
            </span>
            <span class="truncate">{{ cwd || hostLabel(target) }}</span>
            <span v-if="live.branch" class="flex min-w-0 items-center gap-1">
              <UIcon name="i-ph-git-branch-duotone" class="size-3.5 shrink-0" />
              <span class="truncate">{{ live.branch }}</span>
            </span>
            <UButton
              v-if="closable"
              icon="i-ph-x"
              size="xs"
              variant="ghost"
              aria-label="Close this pane"
              class="-my-1 ml-auto"
              @click="emit('close')"
            />
          </header>
          <!-- full pane rows (FitAddon measures el), shown only as far as used -->
          <div
            class="relative"
            :class="!plain && 'mx-3 mb-2'"
            :style="{ height: `${view.used * view.rowHeight}px` }"
          >
            <div class="absolute inset-x-0 top-0 h-full overflow-hidden">
              <div ref="el" :style="{ height: `${paneHeight}px` }" />
            </div>
            <span
              v-if="echoing"
              aria-hidden="true"
              class="pointer-events-none absolute font-mono text-[13px] whitespace-pre text-muted"
              :style="cellStyle(pending.x, pending.y)"
              >{{ pending.text }}</span
            >
            <span
              v-if="rest && !waiting && (echoing || !pending.text)"
              aria-hidden="true"
              class="pointer-events-none absolute font-mono text-[13px] whitespace-pre text-dimmed"
              :style="cellStyle(caret.x, caret.y)"
              >{{ rest }}</span
            >
            <span
              v-if="waiting"
              aria-hidden="true"
              class="lt-late pointer-events-none absolute flex items-center"
              :style="{ ...cellStyle(caret.x + 1, caret.y), height: `${view.rowHeight}px` }"
            >
              <UIcon name="i-ph-circle-notch" class="size-3 animate-spin text-dimmed" />
            </span>
            <!-- whole pixels via transform: fractional `left` leaves stray pixel in WebKitGTK -->
            <span
              v-if="
                state === 'open' &&
                !caret.hidden &&
                caret.y >= view.y &&
                caret.y < view.y + term.rows
              "
              aria-hidden="true"
              class="pointer-events-none absolute top-0 left-0 w-0.5 bg-primary will-change-transform"
              :class="[caret.idle && caret.focused && 'lt-blink', !caret.focused && 'opacity-40']"
              :style="{
                transform: `translate(${Math.round(caret.x * view.cellWidth)}px, ${Math.round((caret.y - view.y + 0.15) * view.rowHeight)}px)`,
                height: `${Math.round(view.rowHeight * 0.7)}px`,
                transition: caret.glide ? 'transform 90ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
              }"
            />
            <!-- mousedown.prevent keeps focus in terminal -->
            <ul
              v-if="menu"
              role="listbox"
              aria-label="Suggestions"
              class="absolute z-10 w-max max-w-md overflow-hidden rounded-md border border-default bg-elevated py-1 font-mono text-xs shadow-lg"
              :style="{
                left: `max(0px, min(${ghost.left - word.length * view.cellWidth}px, 100% - 28rem))`,
                ...(ghost.below
                  ? { top: `${ghost.top + view.rowHeight + 2}px` }
                  : { bottom: `calc(100% - ${ghost.top - 2}px)` }),
              }"
            >
              <li
                v-for="(item, i) in ghost.list"
                :key="item.text"
                role="option"
                :aria-selected="i === ghost.pick"
                class="flex cursor-pointer gap-4 px-2.5 py-1"
                :class="i === ghost.pick ? 'bg-accented text-default' : 'text-muted'"
                @mousedown.prevent="accept(i)"
                @mousemove="ghost.pick = i"
              >
                <span class="min-w-0 flex-auto truncate">
                  <span class="text-primary">{{ word }}</span
                  >{{ item.text.slice(ghost.line.length) }}
                </span>
                <span v-if="item.hint" class="max-w-60 truncate text-dimmed">{{ item.hint }}</span>
              </li>
              <li
                aria-hidden="true"
                class="border-t border-default px-2.5 pt-1 text-[11px] text-dimmed"
              >
                <span class="flex items-center gap-1.5">
                  <UKbd value="arrowup" /><UKbd value="arrowdown" /> pick
                  <UKbd value="arrowright" class="ms-1.5" /> accept
                  <UKbd value="escape" class="ms-1.5" /> close
                </span>
              </li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
