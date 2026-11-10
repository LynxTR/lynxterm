import { expect, test } from "vite-plus/test";
import { moveHead } from "../app/composables/lineSelect";

test("word, letter and line-end moves for keyboard selection", () => {
  const line = "ls -la /var/log";
  expect(moveHead(line, 15, "ArrowLeft", true)).toBe(7);
  expect(moveHead(line, 7, "ArrowLeft", true)).toBe(3);
  expect(moveHead(line, 0, "ArrowRight", true)).toBe(2);
  expect(moveHead(line, 2, "ArrowRight", true)).toBe(6);
  expect(moveHead(line, 0, "ArrowLeft", false)).toBe(0);
  expect(moveHead(line, 15, "ArrowRight", false)).toBe(15);
  expect(moveHead(line, 4, "ArrowRight", false)).toBe(5);
  expect(moveHead(line, 9, "Home", false)).toBe(0);
  expect(moveHead(line, 0, "End", false)).toBe(15);
});
