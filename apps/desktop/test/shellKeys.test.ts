import { expect, test } from "vite-plus/test";
import { shellKey } from "../app/composables/shellKeys";

const press = (
  key: string,
  mods: Partial<Record<"ctrl" | "alt" | "meta" | "shift", boolean>> = {},
) =>
  shellKey({
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
  });

test("text-field shortcuts become shell keys; others pass through", () => {
  expect(press("Backspace", { ctrl: true })).toBe("\x17");
  expect(press("ArrowLeft", { ctrl: true })).toBe("\x1bb");
  expect(press("ArrowRight", { meta: true })).toBe("\x05");
  // plain keys, Shift (selection) and extra modifiers stay the terminal's
  expect(press("Backspace")).toBeUndefined();
  expect(press("ArrowLeft", { ctrl: true, shift: true })).toBeUndefined();
  expect(press("ArrowLeft", { ctrl: true, alt: true })).toBeUndefined();
});
