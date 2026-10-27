import { expect, test } from "vite-plus/test";
import { isNewer } from "../app/composables/useUpdates";

test("newer versions compare by number, not text", () => {
  expect(isNewer("0.10.0", "0.9.2")).toBe(true);
  expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
  expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  expect(isNewer("1.2", "1.2.0")).toBe(false);
  expect(isNewer("1.2.0", "1.2")).toBe(false);
  expect(isNewer("1.10", "1.9.9")).toBe(true);
  expect(isNewer("1.2.1-beta.1", "1.2.0")).toBe(true);
});
