<script setup lang="ts">
import { Terminal } from "@xterm/xterm";
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
    foreground: "#c9d1d9",
    cursor: "#00000000",
    selectionBackground: `${token("--ui-primary", "#ffb020")}40`,
    black: "#2e3440",
    red: "#ff8a8a",
    green: "#3ddc97",
    yellow: "#ffb020",
    blue: "#6cb6ff",
    magenta: "#c792ea",
    cyan: "#5eead4",
    white: "#c9d1d9",
    brightBlack: "#7c8594",
    brightRed: "#ffa8a8",
    brightGreen: "#6ee7b7",
    brightYellow: "#ffc95c",
    brightBlue: "#93c9ff",
    brightMagenta: "#ddb6f2",
    brightCyan: "#99f6e4",
    brightWhite: "#f4f5f7",
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
const ghost = reactive({
  line: "",
  list: [] as Completion[],
  pick: 0,
  open: true,
  below: true,
  left: 0,
  top: 0,
});
// Keys not yet on screen: line read from it is stale, so no suggestion till server catches up.
const rest = computed(() => {
  const full = ghost.list[ghost.pick]?.text ?? "";
  if (pending.behind || !full.startsWith(ghost.line)) return "";
  return full.slice(ghost.line.length);
});
const menu = computed(() => !!rest.value && ghost.open && ghost.list.length > 1);
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
term.parser.registerOscHandler(133, (data) => {
  // Markers before our own setup: hooks are in server's shell files.
  if (setup !== "done" && !settings.integratedHosts.includes(historyKey))
    settings.integratedHosts.push(historyKey);
  integrated.value = true;
  const b = term.buffer.active;
  if (data[0] === "A") reveal();
  else if (data[0] === "B") promptStart = { x: b.cursorX, y: b.baseY + b.cursorY };
  else {
    const command = data[0] === "C" && promptStart ? readLine(promptStart) : "";
    if (command) record(historyKey, command);
    promptStart = null;
  }
  return true;
});

const alternate = ref(false);
term.buffer.onBufferChange((b) => {
  alternate.value = b.type === "alternate";
  measure();
});

/** `gap`: cell minus glyph width; overlays letter-space by it to stay on grid. */
const view = reactive({ y: 0, rowHeight: 0, cellWidth: 0, gap: 0 });
// Cell size: screen box changes with it (resize, zoom, renderer swap). Observed, not read
// on every write.
const screen = shallowRef<HTMLElement | null>(null);
let glyph = 0;
useResizeObserver(screen, ([e]) => {
  view.rowHeight = e!.contentRect.height / term.rows;
  view.cellWidth = e!.contentRect.width / term.cols;
  view.gap = view.cellWidth - glyph;
});
/** Overlay at cell x, buffer row y. */
const cellStyle = (x: number, y: number) => ({
  left: `${x * view.cellWidth}px`,
  top: `${(y - view.y) * view.rowHeight}px`,
  lineHeight: `${view.rowHeight}px`,
  letterSpacing: `${view.gap}px`,
});
const measure = () => (view.y = term.buffer.active.viewportY);
term.onScroll(measure);
term.onResize(measure);
const refocus = () => getSelection()?.toString() || term.focus();

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
  settings.setupLine && !props.target.command ? "wait" : "done";
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

// Host card stays up during login output: until first prompt, login question, or 4s.
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
  ghost.below = ghost.top < (el.value?.clientHeight ?? 0) / 2;
}

function accept(i = ghost.pick) {
  const text = ghost.list[i]?.text.slice(ghost.line.length);
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

// Overlays move after xterm paints: else text, cursor disagree one frame (jitter typing fast).
term.onRender(() => {
  echo.settle();
  placeCaret();
  updateGhost();
  measure();
});

term.onData((data) => {
  if (id === undefined) return;
  if (setup === "hidden") return void (typedAhead += data);
  echo.key(data);
  placeCaret();
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
      // session): reused one gets nothing after trust or retry.
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
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
  glyph = ctx.measureText("W").width;
  term.open(el.value!);
  screen.value = el.value!.querySelector<HTMLElement>(".xterm-screen");
  // GPU renderer; xterm's DOM one when WebGL missing or lost (too many tabs, driver reset).
  // WebGL cells are whole device pixels rounded down (7.8px glyph: 7px, squeezed): letter
  // spacing rounds up instead. ponytail: set once; window moved to other display scale may be
  // one device pixel off, re-set on resolution change if it shows.
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
        title="Turn on shell integration here?"
        description="Lynxterm couldn't spot a shell prompt, so it didn't type its setup line. Turn on only if a shell is waiting for a command."
        :actions="[
          { label: 'Turn on', color: 'primary', onClick: () => typeSetup('\x15') },
          { label: 'Not now', color: 'neutral', variant: 'ghost', onClick: () => (offer = false) },
        ]"
      />
    </div>
    <div
      class="flex min-h-0 flex-1 flex-col px-4 py-3"
      :class="cover ? 'invisible' : 'animate-fade'"
      @mouseup="refocus"
    >
      <div class="relative min-h-0 flex-1">
        <!-- FitAddon measures el -->
        <div ref="el" class="absolute inset-0" />
        <UButton
          v-if="closable"
          icon="i-ph-x"
          size="xs"
          variant="ghost"
          aria-label="Close this pane"
          class="absolute top-0 right-0 z-30"
          @click="emit('close')"
        />
        <span
          v-if="echoing"
          aria-hidden="true"
          class="pointer-events-none absolute right-0 bg-default font-mono text-[13px] whitespace-pre text-muted"
          :style="{ ...cellStyle(pending.x, pending.y), height: `${view.rowHeight}px` }"
          >{{ pending.text }}</span
        >
        <span
          v-if="rest && !waiting"
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
            state === 'open' && !caret.hidden && caret.y >= view.y && caret.y < view.y + term.rows
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
    </div>
  </div>
</template>
