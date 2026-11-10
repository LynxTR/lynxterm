import type { IBufferCell, IBufferLine } from "@xterm/xterm";

export const ANSI = {
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
};
export const FOREGROUND = "#c9d1d9";
const BACKGROUND = "#0b0d10";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
// 256-color palette: 16 ANSI, 6×6×6 cube, 24 greys.
const LEVELS = [0, 95, 135, 175, 215, 255];
const PALETTE = [
  ...Object.values(ANSI),
  ...Array.from({ length: 216 }, (_, i) =>
    hex(
      (LEVELS[Math.floor(i / 36)]! << 16) | (LEVELS[Math.floor(i / 6) % 6]! << 8) | LEVELS[i % 6]!,
    ),
  ),
  ...Array.from({ length: 24 }, (_, i) => hex((8 + i * 10) * 0x010101)),
];

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function fg(c: IBufferCell) {
  if (c.isFgRGB()) return hex(c.getFgColor());
  // Bold ANSI color shows bright, as in xterm.
  if (c.isFgPalette()) return PALETTE[c.getFgColor() + (c.isBold() && c.getFgColor() < 8 ? 8 : 0)];
}
function bg(c: IBufferCell) {
  if (c.isBgRGB()) return hex(c.getBgColor());
  if (c.isBgPalette()) return PALETTE[c.getBgColor()];
}

/** Cell style: computed colors only, never server text. */
function style(c: IBufferCell) {
  let [color, back] = [fg(c), bg(c)];
  if (c.isInverse()) [color, back] = [back ?? BACKGROUND, color ?? FOREGROUND];
  const lines = [c.isUnderline() && "underline", c.isStrikethrough() && "line-through"];
  return [
    color && `color:${color}`,
    back && `background:${back}`,
    c.isBold() && "font-weight:600",
    c.isItalic() && "font-style:italic",
    c.isDim() && "opacity:.5",
    c.isInvisible() && "visibility:hidden",
    lines.some(Boolean) && `text-decoration:${lines.filter(Boolean).join(" ")}`,
  ]
    .filter(Boolean)
    .join(";");
}

/** Row as escaped HTML. `trim`: drop trailing blanks (not before wrap). */
export function rowHtml(line: IBufferLine, cell: IBufferCell, trim = true) {
  let end = line.length;
  while (trim && end > 0) {
    const c = line.getCell(end - 1, cell);
    if (!c || c.getChars() || !c.isBgDefault() || c.isInverse()) break;
    end--;
  }
  let html = "";
  let run = "";
  let runStyle = "";
  const flush = () => {
    if (run)
      html += runStyle ? `<span style="${runStyle}">${escapeHtml(run)}</span>` : escapeHtml(run);
    run = "";
  };
  for (let x = 0; x < end; x++) {
    const c = line.getCell(x, cell);
    if (!c || !c.getWidth()) continue; // right half of wide character
    const s = style(c);
    if (s !== runStyle) {
      flush();
      runStyle = s;
    }
    run += c.getChars() || " ";
  }
  flush();
  return html;
}
