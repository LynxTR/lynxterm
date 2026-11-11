// Drawn over terminal, never written: wrong guess just vanishes. Grey only after server echoed
// key on this line: non-echoing prompt (password) never shows typed text.
// Line kept after every key: server replays them in order, deleted chars too. Guess and its
// background cover row till server reaches last one, so replay never flashes.

interface EchoScreen {
  readonly cols: number;
  /** Absolute cursor cell. */
  cursor(): { x: number; y: number };
  /** Character in cell; "" when blank. */
  cell(x: number, y: number): string;
  restBlank(): boolean;
  /** Off, full-screen app, login question: no guess. */
  unsafe(): boolean;
}

const SLOW_MS = 30;

export const echoState = () => ({
  text: "",
  x: 0,
  y: 0,
  cover: false,
  behind: false,
  echoes: false,
  latency: 0,
  sent: false,
});

export function localEcho(screen: EchoScreen, pending = echoState()) {
  let anchor = { x: 0, y: 0 };
  let lines: string[] = []; // line from anchor after each key; [0] before them
  let sentAt: number[] = [];
  let seen = 0; // newest line server shows
  const last = () => lines.at(-1) ?? "";

  function clear() {
    lines = [];
    sentAt = [];
    seen = 0;
    Object.assign(pending, { text: "", cover: false, behind: false, sent: false, echoes: false });
  }

  function start() {
    anchor = screen.cursor();
    lines = [""];
    sentAt = [0];
    seen = 0;
  }

  function push(line: string) {
    lines.push(line);
    sentAt.push(performance.now());
    draw();
  }

  /** text: guessed chars server lacks. cover: server still shows chars guess dropped. behind:
   *  keys not yet on screen. */
  function draw() {
    const line = last();
    let n = 0;
    while (n < line.length && screen.cell(anchor.x + n, anchor.y) === line[n]) n++;
    const behind = seen < lines.length - 1;
    let cover = false;
    const width = Math.max(...lines.map((l) => l.length));
    for (let i = line.length; i < width && behind; i++)
      cover ||= !!screen.cell(anchor.x + i, anchor.y).trim();
    Object.assign(pending, { x: anchor.x + n, y: anchor.y, text: line.slice(n), cover, behind });
  }

  /** Every key, before server. */
  function key(data: string) {
    if (pending.sent) clear(); // typed ahead: next line, position unknown
    if (data === "\r" && !screen.unsafe()) {
      if (!lines.length) start();
      pending.sent = true;
      return;
    }
    const erase = data === "\x7f" || data === "\b";
    // Tab, arrows, Ctrl keys, login question: result unknown, server's answer shows.
    if ((!erase && ![...data].every((c) => c >= " " && c !== "\x7f")) || screen.unsafe())
      return clear();
    if (!lines.length) {
      if (erase || !screen.restBlank()) return clear();
      start();
    }
    // Erasing text from before guess: unknown.
    if (erase) return last() ? push(last().slice(0, -1)) : clear();
    if (anchor.x + last().length + data.length >= screen.cols) return clear();
    push(last() + data);
  }

  /** After output: follow server through lines; anything else on screen: server wins. */
  function settle() {
    if (!lines.length) return;
    const at = screen.cursor();
    if (at.y !== anchor.y || at.x < anchor.x) return clear();
    let shown = "";
    for (let x = anchor.x; x < at.x; x++) shown += screen.cell(x, anchor.y) || " ";
    // Oldest match: line back at earlier text (typed, then deleted) still has replay coming.
    const j = lines.indexOf(shown, seen);
    if (j > seen) {
      const took = performance.now() - sentAt[j]!;
      pending.latency = pending.latency ? pending.latency * 0.7 + took * 0.3 : took;
      pending.echoes = true;
      seen = j;
    } else if (j < 0 && !lines.slice(seen).some((l) => l.startsWith(shown))) return clear();
    if (seen === lines.length - 1) {
      lines = [last()];
      sentAt = [0];
      seen = 0;
    }
    draw();
  }

  const slow = () => pending.latency > SLOW_MS;
  const visible = () => pending.echoes && slow() && (!!pending.text || pending.cover);
  // Server cursor sits at line end till Enter is answered: next row clears it.
  const waiting = () => pending.sent && slow();
  return { pending, visible, waiting, key, settle };
}
