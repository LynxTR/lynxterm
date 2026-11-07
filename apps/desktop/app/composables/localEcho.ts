// Slow link: typed text grey at cursor till server echoes (as Mosh). Drawn over terminal,
// never written: wrong guess just vanishes. Grey only after server echoed a key on this line:
// non-echoing prompt (password) never shows typed text.

interface EchoScreen {
  readonly cols: number;
  /** Absolute cursor cell. */
  cursor(): { x: number; y: number };
  /** Character in cell; "" when blank. */
  cell(x: number, y: number): string;
  /** Nothing right of cursor that typing would push along. */
  restBlank(): boolean;
  /** Off, full-screen app, login question: no guess. */
  unsafe(): boolean;
}

/** Faster round trip: echo arrives before grey shows. */
const SLOW_MS = 30;

/** `text` waits for server at cell x, y. `echoes`: server echoed a key on this line. */
export const echoState = () => ({ text: "", x: 0, y: 0, echoes: false, latency: 0 });

/** Caller passes `pending`: can be reactive. */
export function localEcho(screen: EchoScreen, pending = echoState()) {
  let sentAt: number[] = []; // per pending character

  function clear(newLine = false) {
    pending.text = "";
    sentAt = [];
    if (newLine) pending.echoes = false;
  }

  /** Every key, before server. */
  function key(data: string) {
    if (data === "\r" || data === "\x03" || data === "\x04") return clear(true);
    if (data === "\x7f" || data === "\b") {
      pending.text = pending.text.slice(0, -1);
      sentAt.pop();
      return;
    }
    // Tab, arrows, Ctrl keys: result unknown, server's answer shows.
    if (![...data].every((c) => c >= " " && c !== "\x7f") || screen.unsafe()) return clear();
    if (!pending.text) {
      if (!screen.restBlank()) return;
      Object.assign(pending, screen.cursor());
    }
    if (pending.x + pending.text.length + data.length >= screen.cols) return clear(); // would wrap
    pending.text += data;
    sentAt.push(...Array.from(data, () => performance.now()));
  }

  /** After output: drop what server now shows; mismatch: server wins. */
  function settle() {
    let n = 0;
    while (n < pending.text.length) {
      const c = screen.cell(pending.x + n, pending.y);
      if (!c) break;
      if (c !== pending.text[n]) return clear(true);
      n++;
    }
    if (!n) return;
    const took = performance.now() - sentAt[n - 1]!;
    pending.latency = pending.latency ? pending.latency * 0.7 + took * 0.3 : took;
    pending.echoes = true;
    pending.text = pending.text.slice(n);
    pending.x += n;
    sentAt = sentAt.slice(n);
  }

  const visible = () => !!pending.text && pending.echoes && pending.latency > SLOW_MS;
  return { pending, visible, key, settle };
}
