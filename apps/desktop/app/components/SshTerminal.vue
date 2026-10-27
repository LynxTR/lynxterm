<script setup lang="ts">
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useResizeObserver } from "@vueuse/core";
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
}

export type SessionState = "connecting" | "open" | "closed";

const props = defineProps<{ target: SshTarget; closable?: boolean }>();
const emit = defineEmits<{
  state: [SessionState];
  session: [number]; // Rust session id, for SFTP and snippets
  focus: [];
  close: [];
}>();
const el = useTemplateRef("el");
const error = ref("");
const unknownHost = ref(""); // fingerprint awaiting user approval
const state = ref<SessionState>("connecting");
const size = ref({ cols: 0, rows: 0 });
const { keys } = useKeys();
const keyName = computed(() => keys.value.find((k) => k.id === props.target.keyId)?.name);
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
  cursorBlink: true,
  allowProposedApi: true, // markers and decorations, for command blocks
  // Base colors from app tokens (main.css): terminal and chrome share one palette. ANSI fixed.
  theme: {
    background: token("--ui-bg", "#0b0d10"),
    foreground: "#c9d1d9",
    cursor: token("--ui-primary", "#ffb020"),
    cursorAccent: token("--ui-bg", "#0b0d10"),
    selectionBackground: `${token("--ui-primary", "#ffb020")}40`,
    black: "#2e3440",
    brightBlack: "#7c8594",
    red: "#ff8a8a",
    brightRed: "#ffa8a8",
    green: "#3ddc97",
    brightGreen: "#6ee7b7",
    yellow: "#ffb020",
    brightYellow: "#ffc95c",
    blue: "#6cb6ff",
    brightBlue: "#93c9ff",
    magenta: "#c792ea",
    brightMagenta: "#ddb6f2",
    cyan: "#5eead4",
    brightCyan: "#99f6e4",
    white: "#c9d1d9",
    brightWhite: "#f4f5f7",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
// Fit only once open (onMounted waits for fonts first).
useResizeObserver(el, () => term.element && fit.fit());
let id: number | undefined;

// ── Suggestions ────────────────────────────────────────────────────────
// With shell integration, shell marks command line start (OSC 133): read exact line from
// screen. Without it, follow keystrokes; give up when shell edits line out of sight.
const { record, suggest } = useHistory();
const historyKey = hostKey(props.target);
const commands = ref<string[]>([]); // server PATH, fetched once per session
const integrated = ref(false);
const cwd = ref("");
// `list`: every completion for `line`; picked one drawn after cursor.
const ghost = reactive({
  line: "",
  list: [] as Completion[],
  pick: 0,
  open: true, // Esc closes menu until line changes
  below: true, // menu under cursor, or above near bottom
  left: 0,
  top: 0,
  width: 0, // of a cell
  height: 0,
});
const rest = computed(() => ghost.list[ghost.pick]?.text.slice(ghost.line.length) ?? "");
const menu = computed(() => ghost.open && ghost.list.length > 1);
// Word being completed: menu lines up under its first letter.
const word = computed(() => ghost.line.slice(ghost.line.lastIndexOf(" ") + 1));
let promptStart: { x: number; y: number } | null = null; // absolute cell after prompt
let typed = "";
let stale = false;

/** Text from `start` to command line end, or only up to cursor. */
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
  const block = blocks.at(-1);
  if (data[0] === "B") promptStart = { x: b.cursorX, y: b.baseY + b.cursorY };
  else if (data[0] === "C") {
    const command = promptStart ? readLine(promptStart) : ""; // exactly as run, edits included
    if (command) record(historyKey, command);
    // cursor on first output line
    if (block) Object.assign(block, { start: Date.now(), command, out: mark() });
    promptStart = null;
  } else {
    // "D;1": command just ended, with exit status
    if (data.startsWith("D;") && block?.start && block.status === undefined)
      Object.assign(block, {
        status: Number(data.slice(2)),
        ms: Date.now() - block.start,
        end: mark(),
        endX: b.cursorX, // past 0: output's last line has no newline
      });
    promptStart = null;
  }
  return true;
});
term.parser.registerOscHandler(7, (data) => {
  try {
    cwd.value = decodeURIComponent(new URL(data).pathname);
  } catch {
    // not a file:// URL
  }
  return true;
});

// ── Command blocks ─────────────────────────────────────────────────────
// Warp-style, server untouched: once shell first goes quiet, hooks typed in as one line.
// All hidden until they report back; then old prompt erased, shell draws hooked one. Above
// each command hooks print empty line carrying divider and only what prompt doesn't show:
// git branch, and once command ends, failure or slow run.
interface Block {
  id: number;
  marker: IMarker; // header row
  el?: HTMLElement;
  branch: string;
  command?: string;
  out?: IMarker; // first output line
  end?: IMarker; // cursor when command ended
  endX?: number;
  start?: number;
  ms?: number;
  status?: number;
}
const mark = () => markRaw(term.registerMarker(0));
const blocks = reactive<Block[]>([]);
const where = { branch: "" }; // latest OSC 633 properties
const alternate = ref(false); // vim, htop…: blocks belong to normal screen
term.buffer.onBufferChange((b) => (alternate.value = b.type === "alternate"));

term.parser.registerOscHandler(633, (data) => {
  const [kind, value = ""] = data.split(/;(.*)/s);
  if (kind === "P") {
    const [key, val = ""] = value.split(/=(.*)/s);
    if (key === "Branch") where.branch = val;
  } else if (kind === "H" && term.buffer.active.cursorX === 0) {
    // hooks print "\n" next: this row stays empty
    const marker = term.registerMarker(0);
    const decoration = term.registerDecoration({ marker, width: term.cols, layer: "top" });
    if (!decoration) return true;
    const block = reactive<Block>({ id: marker.id, marker: markRaw(marker), ...where });
    decoration.onRender((el) => {
      if (block.el) return;
      el.classList.add("lt-block");
      block.el = el;
    });
    marker.onDispose(() => {
      blocks.splice(blocks.indexOf(block), 1);
      block.out?.dispose();
      block.end?.dispose();
    });
    blocks.push(block);
  }
  return true;
});

// Block positions on screen. Sections drawn over terminal from outside, so they reach its padding.
const view = reactive({ y: 0, rowHeight: 0 });
function measure() {
  const screen = el.value?.querySelector<HTMLElement>(".xterm-screen");
  if (screen) view.rowHeight = screen.clientHeight / term.rows;
  view.y = term.buffer.active.viewportY;
}
term.onScroll(measure);
term.onWriteParsed(measure);
term.onResize(measure);

/** Block's first and last buffer line: header down to next one, minus empty row hooks print
 *  between blocks (hooks installed before it have none). */
function lines(block: Block) {
  const next = blocks[blocks.indexOf(block) + 1];
  const b = term.buffer.active;
  if (!next) return [block.marker.line, b.baseY + b.cursorY] as const;
  let last = next.marker.line - 1;
  if (last > block.marker.line && !b.getLine(last)?.translateToString(true)) last--;
  return [block.marker.line, last] as const;
}
/** px under section's last line, taken from empty row below it. */
const PAD = 6;
/** Top and height in px within padded area, clipped to screen; undefined when off it. */
function box([first, last]: readonly [number, number]) {
  const top = Math.max(first - view.y, 0);
  const bottom = Math.min(last - view.y + 1, term.rows);
  if (bottom <= top) return;
  const pad = last - view.y + 1 < term.rows ? PAD : 0;
  return {
    top: `${16 + top * view.rowHeight}px`,
    height: `${(bottom - top) * view.rowHeight + pad}px`,
  };
}

const hovered = ref<Block>();
function hover(e: MouseEvent) {
  const screen = el.value?.querySelector(".xterm-screen");
  if (!screen || alternate.value) return (hovered.value = undefined);
  measure();
  const row = Math.floor((e.clientY - screen.getBoundingClientRect().top) / view.rowHeight);
  hovered.value = blocks.findLast((b) => b.marker.line <= view.y + row);
}
/** Blocks whose command ran; each gets a section behind it. */
const sections = computed(() => blocks.filter((b) => b.command));
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Output as plain text, wrapped lines rejoined. */
function output(block: Block) {
  if (!block.out || !block.end) return "";
  const b = term.buffer.active;
  const last = block.end.line - (block.endX ? 0 : 1);
  let text = "";
  for (let y = block.out.line; y <= last; y++) {
    const line = b.getLine(y);
    if (!line) break;
    text += (y > block.out.line && !line.isWrapped ? "\n" : "") + line.translateToString(true);
  }
  return text.replace(/\n+$/, "");
}
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
let setup: "wait" | "hidden" | "done" = settings.blocks ? "wait" : "done";
let timer: ReturnType<typeof setTimeout> | undefined;
let held = ""; // output while hidden
let typedAhead = ""; // keys pressed while hidden
const decoder = new TextDecoder();

function startSetup() {
  if (setup !== "wait" || state.value === "closed") return;
  // Prompt leaves cursor after it; at column 0 login still printing.
  if (id === undefined || term.buffer.active.cursorX === 0)
    return void (timer = setTimeout(startSetup, 400));
  setup = "hidden";
  invoke("ssh_write", { id, data: SETUP });
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
  if (typedAhead) send(typedAhead);
  typedAhead = "";
}

function receive(bytes: Uint8Array) {
  if (setup !== "hidden") {
    term.write(bytes);
    // Wait for shell to go quiet: that is when it shows first prompt.
    if (setup === "wait") {
      clearTimeout(timer);
      timer = setTimeout(startSetup, 400);
    }
    return;
  }
  held += decoder.decode(bytes, { stream: true });
  const ready = /\x1b\]633;Ready;(\d+)\x07/.exec(held);
  if (ready) finishSetup(held.slice(ready.index + ready[0].length), Number(ready[1]));
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
  if (term.buffer.active.type === "alternate") return void (stale = true); // vim, htop, less…
  const printable = [...data].every((c) => c >= " " && c !== "\x7f");
  if (data === "\r") {
    if (!stale && typed && echoed(typed)) record(historyKey, typed);
    typed = "";
    stale = false;
  } else if (data === "\x7f" || data === "\b") {
    typed = typed.slice(0, -1);
  } else if (data === "\x03" || data === "\x15") {
    typed = ""; // Ctrl-C, Ctrl-U: line starts over
    stale = false;
  } else if (printable) {
    typed += data;
  } else {
    stale = true; // arrows, Tab, Ctrl-R…: shell changed line out of sight
  }
}

function currentLine(): string | null {
  const b = term.buffer.active;
  if (b.type === "alternate" || b.viewportY !== b.baseY) return null; // full-screen app, or scrolled up
  if (!integrated.value) return stale ? null : typed;
  if (!promptStart) return null;
  const upToCursor = readLine(promptStart, true);
  return upToCursor === readLine(promptStart) ? upToCursor : null; // only with cursor at end
}

function updateGhost() {
  const line = currentLine() ?? "";
  if (line !== ghost.line) Object.assign(ghost, { line, pick: 0, open: true });
  // History and snippets first: what ran here beats what could run.
  const found = [
    ...suggest(historyKey, line, commands.value).map((text) => ({ text })),
    ...figComplete(line, updateGhost),
  ];
  ghost.list = found.filter((c, i) => found.findIndex((o) => o.text === c.text) === i).slice(0, 8);
  const screen = el.value?.querySelector<HTMLElement>(".xterm-screen");
  if (!ghost.list.length || !screen) return;
  const b = term.buffer.active;
  ghost.height = screen.clientHeight / term.rows;
  ghost.width = screen.clientWidth / term.cols;
  ghost.left = b.cursorX * ghost.width;
  ghost.top = b.cursorY * ghost.height;
  ghost.below = b.cursorY < term.rows / 2;
}
term.onWriteParsed(updateGhost);
term.onCursorMove(updateGhost);
term.onScroll(updateGhost);

function accept(i = ghost.pick) {
  const text = ghost.list[i]?.text.slice(ghost.line.length);
  if (!text || id === undefined) return;
  ghost.list = [];
  if (!integrated.value) typed += text;
  invoke("ssh_write", { id, data: text });
  term.focus();
}

// Fish-style: Right arrow at line end accepts suggestion. Tab and Enter stay the shell's.
term.attachCustomKeyEventHandler((e) => {
  // User typing: setup now would land mid-line. Not in onData: xterm also answers server's
  // terminal queries through it.
  if (e.type === "keydown" && setup === "wait") {
    setup = "done";
    clearTimeout(timer);
  }
  const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (e.type !== "keydown" || !plain || !rest.value) return true;
  const n = ghost.list.length;
  if (e.key === "ArrowRight") accept();
  else if (menu.value && e.key === "ArrowDown") ghost.pick = (ghost.pick + 1) % n;
  else if (menu.value && e.key === "ArrowUp") ghost.pick = (ghost.pick + n - 1) % n;
  else if (menu.value && e.key === "Escape") ghost.open = false;
  else return true;
  return false;
});

const installing = ref(false);
const installIntegration = () =>
  withBusy(installing, async () => {
    await invoke("shell_integration_install", { id });
    logActivity(props.target, {
      kind: "integration",
      title: "Installed shell integration",
      detail: "~/.bashrc, ~/.zshrc",
    });
    toast.add({
      title: "Shell integration installed",
      description: "It takes effect in new sessions, or reload the shell here.",
      icon: "i-ph-sparkle-duotone",
      actions: [
        {
          label: "Reload shell",
          // Leading space: never saved to history.
          onClick: () => invoke("ssh_write", { id, data: ' exec "$SHELL"\r' }),
        },
      ],
    });
  });

const onData = new Channel<ArrayBuffer>();
onData.onmessage = (buf) => {
  if (buf.byteLength) return receive(new Uint8Array(buf));
  // Empty frame: session ended.
  if (setup === "hidden") finishSetup(held);
  term.write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
  state.value = "closed";
};
function send(data: string) {
  track(data);
  invoke("ssh_write", { id, data });
}
term.onData((data) => {
  if (id === undefined) return;
  if (setup === "hidden") return void (typedAhead += data);
  send(data);
});
term.onResize(({ cols, rows }) => {
  size.value = { cols, rows };
  if (id !== undefined) invoke("ssh_resize", { id, cols, rows });
});

async function open(trust?: string) {
  error.value = unknownHost.value = "";
  state.value = "connecting";
  try {
    id = await invoke<number>("ssh_open", {
      ...props.target,
      trust,
      cols: term.cols,
      rows: term.rows,
      onData,
    });
    state.value = "open";
    emit("session", id);
    invoke<string[]>("ssh_commands", { id })
      .then((list) => (commands.value = list))
      .catch(() => {}); // suggestions skip PATH commands
    term.focus();
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("unknown-host:")) unknownHost.value = msg.slice("unknown-host:".length);
    else error.value = msg;
    state.value = "closed";
  }
}

onMounted(async () => {
  // xterm measures font once, on open
  await Promise.all([
    document.fonts.load('13px "JetBrains Mono"'),
    document.fonts.load('13px "Symbols Nerd Font Mono"', "\ue0b0"),
  ]);
  term.open(el.value!);
  term.textarea?.addEventListener("focus", () => emit("focus"));
  fit.fit();
  size.value = { cols: term.cols, rows: term.rows };
  open();
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  if (id !== undefined) invoke("ssh_close", { id });
  term.dispose();
});
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div v-if="error || unknownHost" class="flex flex-col gap-3 px-5 pt-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-ph-warning-circle-duotone"
        :title="error"
      />
      <UAlert
        v-if="unknownHost"
        color="warning"
        variant="subtle"
        icon="i-ph-shield-warning-duotone"
        title="First connection to this host"
        :description="`Its key fingerprint is ${unknownHost}. Trust it only if it matches the server's.`"
        :actions="[{ label: 'Trust and connect', onClick: () => open(unknownHost) }]"
      />
    </div>
    <!-- padding on wrapper: FitAddon measures element it is given -->
    <div class="relative min-h-0 flex-1 px-5 py-4">
      <template v-if="!alternate">
        <div
          v-for="block in sections"
          :key="block.id"
          class="pointer-events-none absolute inset-x-2 z-10 rounded-md border border-white/[0.06] bg-white/[0.02]"
          :class="hovered === block && 'bg-white/[0.04]'"
          :style="box(lines(block))"
        />
      </template>
      <div
        class="relative h-full overflow-hidden"
        @mousemove="hover"
        @mouseleave="hovered = undefined"
      >
        <div ref="el" class="h-full" />
        <!-- each block's header, inside empty row xterm keeps for it -->
        <template v-for="block in blocks" :key="block.id">
          <Teleport v-if="block.el && !alternate" :to="block.el">
            <div class="flex h-full items-center gap-3 px-2.5 font-sans text-[11px] text-dimmed">
              <template v-if="block.command">
                <span v-if="block.status === undefined">running</span>
                <span v-else :class="block.status && 'text-error'">exit {{ block.status }}</span>
                <span v-if="(block.ms ?? 0) >= 1000">{{ took(block.ms!) }}</span>
                <span v-if="block.start">{{ clock(block.start) }}</span>
              </template>
              <span v-if="block.branch" class="flex min-w-0 items-center gap-1">
                <UIcon name="i-ph-git-branch-duotone" class="size-3.5 shrink-0" />
                <span class="truncate">{{ block.branch }}</span>
              </span>
              <!-- mousedown.stop: no text selection in terminal -->
              <span v-if="hovered === block && block.command" class="ml-auto flex gap-3">
                <button
                  class="hover:text-default"
                  @mousedown.prevent.stop
                  @click="copy(block.command, 'command')"
                >
                  copy command
                </button>
                <button
                  v-if="output(block)"
                  class="hover:text-default"
                  @mousedown.prevent.stop
                  @click="copy(output(block), 'output')"
                >
                  copy output
                </button>
              </span>
            </div>
          </Teleport>
        </template>
        <span
          v-if="rest"
          aria-hidden="true"
          class="pointer-events-none absolute font-mono text-[13px] whitespace-pre text-dimmed"
          :style="{
            left: `${ghost.left}px`,
            top: `${ghost.top}px`,
            height: `${ghost.height}px`,
            lineHeight: `${ghost.height}px`,
          }"
          >{{ rest }}</span
        >
        <!-- mousedown.prevent keeps focus in terminal -->
        <ul
          v-if="menu"
          role="listbox"
          aria-label="Suggestions"
          class="absolute z-10 w-max max-w-md overflow-hidden rounded-md border border-default bg-elevated py-1 font-mono text-xs shadow-lg"
          :style="{
            left: `max(0px, min(${ghost.left - word.length * ghost.width}px, 100% - 28rem))`,
            ...(ghost.below
              ? { top: `${ghost.top + ghost.height + 2}px` }
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
    <footer
      class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-default bg-sunken px-4 py-2 font-mono text-xs text-muted"
    >
      <span v-if="state === 'open'" class="flex items-center gap-1.5 text-success">
        <UIcon name="i-ph-shield-check-duotone" class="size-4" />
        host key verified
      </span>
      <span v-else-if="state === 'connecting'" class="text-primary">connecting…</span>
      <span v-else class="text-dimmed">disconnected</span>
      <span>{{ target.user }}@{{ maskHost(target.host) }}:{{ target.port }}</span>
      <span>{{ keyName ? `key: ${keyName}` : "password" }}</span>
      <span v-if="integrated" class="flex min-w-0 items-center gap-1.5" title="Shell integration">
        <UIcon name="i-ph-sparkle-duotone" class="size-4 shrink-0 text-primary" />
        <span class="truncate">{{ cwd || "shell integration" }}</span>
      </span>
      <UButton
        v-else-if="state === 'open'"
        icon="i-ph-sparkle-duotone"
        label="Enable shell integration"
        size="xs"
        color="neutral"
        variant="ghost"
        class="-my-1"
        :loading="installing"
        @click="installIntegration"
      />
      <span class="ml-auto">{{ size.cols }}×{{ size.rows }}</span>
      <span>UTF-8</span>
      <UButton
        v-if="closable"
        icon="i-ph-x"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="Close this pane"
        class="-my-1"
        @click="emit('close')"
      />
    </footer>
  </div>
</template>
