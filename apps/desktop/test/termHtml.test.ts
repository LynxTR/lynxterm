import type { IBufferCell, IBufferLine } from "@xterm/xterm";
import { expect, test } from "vite-plus/test";
import { rowHtml } from "../app/composables/termHtml";

type Fake = { ch: string; fg?: number; rgb?: number; bold?: boolean; bg?: number };
/** Row from cells; only the parts rowHtml reads. */
function row(cells: Fake[]) {
  const cell = (f: Fake = { ch: "" }) =>
    ({
      getChars: () => f.ch,
      getWidth: () => 1,
      isFgRGB: () => f.rgb !== undefined,
      isFgPalette: () => f.fg !== undefined,
      getFgColor: () => f.rgb ?? f.fg ?? 0,
      isBgRGB: () => false,
      isBgPalette: () => f.bg !== undefined,
      isBgDefault: () => f.bg === undefined,
      getBgColor: () => f.bg ?? 0,
      isBold: () => +!!f.bold,
      isItalic: () => 0,
      isDim: () => 0,
      isUnderline: () => 0,
      isStrikethrough: () => 0,
      isInverse: () => 0,
      isInvisible: () => 0,
    }) as unknown as IBufferCell;
  const line = {
    length: cells.length + 3, // blank cells at end
    getCell: (x: number) => cell(cells[x]),
  } as unknown as IBufferLine;
  return rowHtml(line, cell());
}
const text = (s: string, extra: Partial<Fake> = {}) => [...s].map((ch) => ({ ch, ...extra }));

test("server text is escaped, never markup", () => {
  const html = row(text(`<img src=x onerror="alert(1)">&'`));
  expect(html).toBe("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;&#38;&#39;");
  expect(html).not.toContain("<");
});

test("colors become inline styles, one span per run, end trimmed", () => {
  expect(row([...text("ok ", { fg: 2 }), ...text("x", { rgb: 0x123456 }), ...text("!")])).toBe(
    '<span style="color:#3ddc97">ok </span><span style="color:#123456">x</span>!',
  );
  // bold ANSI red shows bright red
  expect(row(text("E", { fg: 1, bold: true }))).toBe(
    '<span style="color:#ffa8a8;font-weight:600">E</span>',
  );
  // 256-color cube and grey ramp
  expect(row(text("c", { fg: 196 }))).toBe('<span style="color:#ff0000">c</span>');
  expect(row(text("g", { fg: 244 }))).toBe('<span style="color:#808080">g</span>');
});
