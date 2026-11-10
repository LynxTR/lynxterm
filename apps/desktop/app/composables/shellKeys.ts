type Combo = { key: string; ctrl?: boolean; alt?: boolean; meta?: boolean };

const KEYS: [Combo, string, string][] = [
  [{ key: "Backspace", ctrl: true }, "\x17", "delete word before cursor"],
  [{ key: "Delete", ctrl: true }, "\x1bd", "delete word after cursor"],
  [{ key: "ArrowLeft", ctrl: true }, "\x1bb", "back one word"],
  [{ key: "ArrowRight", ctrl: true }, "\x1bf", "forward one word"],
  [{ key: "ArrowLeft", alt: true }, "\x1bb", "back one word"],
  [{ key: "ArrowRight", alt: true }, "\x1bf", "forward one word"],
  [{ key: "Backspace", alt: true }, "\x17", "delete word before cursor"],
  [{ key: "ArrowLeft", meta: true }, "\x01", "start of line"],
  [{ key: "ArrowRight", meta: true }, "\x05", "end of line"],
  [{ key: "Backspace", meta: true }, "\x15", "delete to start of line"],
];

type Pressed = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

export const shellKey = (e: Pressed) =>
  KEYS.find(
    ([c]) =>
      c.key === e.key &&
      !e.shiftKey &&
      !!c.ctrl === e.ctrlKey &&
      !!c.alt === e.altKey &&
      !!c.meta === e.metaKey,
  )?.[1];
