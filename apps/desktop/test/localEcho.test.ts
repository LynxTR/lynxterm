import { expect, test } from "vite-plus/test";
import { localEcho } from "../app/composables/localEcho";

function setup(prompt: string, unsafe = false) {
  const row: string[] = [...prompt];
  let cursor = row.length;
  const echo = localEcho({
    cols: 80,
    cursor: () => ({ x: cursor, y: 0 }),
    cell: (x) => row[x] ?? "",
    restBlank: () => true,
    unsafe: () => unsafe,
  });
  const server = (text: string, at: number) => {
    row.splice(at, text.length, ...text);
    cursor = at + text.length;
    echo.settle();
  };
  // Shell's backspace echo: "\b \b"
  const erase = (at: number) => {
    row[at] = " ";
    cursor = at;
    echo.settle();
  };
  return { echo, server, erase };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("grey only after server echoed a key on this line, then confirmed away", async () => {
  const { echo, server } = setup("$ ");
  echo.key("l");
  expect(echo.visible()).toBe(false);
  await new Promise((r) => setTimeout(r, 40)); // slow link
  server("l", 2);
  echo.key("s");
  echo.key(" ");
  expect(echo.visible()).toBe(true);
  expect(echo.pending.text).toBe("s ");
  server("s", 3);
  expect(echo.pending).toMatchObject({ text: " ", x: 4 });
  echo.key("\x7f");
  expect(echo.visible()).toBe(false);
});

test("password prompt never shows typed text", async () => {
  const { echo } = setup("Password: ", true);
  echo.key("h");
  echo.key("i");
  expect(echo.pending.text).toBe("");
  // Not recognised as login question: still hidden, server never echoes
  const quiet = setup("PIN ");
  quiet.echo.key("1");
  quiet.echo.key("2");
  await new Promise((r) => setTimeout(r, 40));
  quiet.echo.settle();
  expect(quiet.echo.visible()).toBe(false);
});

test("server showing something else wins, Enter starts over", async () => {
  const { echo, server } = setup("$ ");
  echo.key("a");
  await new Promise((r) => setTimeout(r, 40));
  server("a", 2);
  echo.key("b");
  server("X", 3);
  expect(echo.pending.text).toBe("");
  echo.key("c");
  expect(echo.visible()).toBe(false); // must echo again first
  echo.key("\r");
  expect(echo.visible()).toBe(false);
});

test("Enter keeps grey and waits till server moves cursor", async () => {
  const { echo, server } = setup("$ ");
  echo.key("a");
  await new Promise((r) => setTimeout(r, 40));
  server("a", 2);
  echo.key("b");
  echo.key("\r");
  expect(echo.visible()).toBe(true);
  expect(echo.waiting()).toBe(true);
  await new Promise((r) => setTimeout(r, 40));
  server("b", 3); // echoed, newline not yet
  expect(echo.waiting()).toBe(true);
  server("\n", 4);
  expect(echo.waiting()).toBe(false);
  expect(echo.pending.text).toBe("");
});

test("fast typing and deleting: server replay stays under guess", async () => {
  const { echo, server, erase } = setup("$ ");
  echo.key("a");
  await sleep(40);
  server("a", 2);
  for (const k of ["b", "c", "\x7f", "\x7f", "x"]) echo.key(k);
  expect(echo.visible()).toBe(true);
  expect(echo.pending.behind).toBe(true); // suggestions wait: screen line is stale
  expect(echo.pending).toMatchObject({ x: 3, text: "x" });
  await sleep(40);
  // Server replays every key: b, c, two erases, x. Screen never flashes deleted chars.
  server("b", 3);
  expect(echo.pending).toMatchObject({ x: 3, text: "x" });
  server("c", 4);
  expect(echo.visible()).toBe(true);
  expect(echo.pending.cover).toBe(true);
  erase(4);
  erase(3);
  expect(echo.pending).toMatchObject({ x: 3, text: "x" });
  server("x", 3);
  expect(echo.visible()).toBe(false);
  expect(echo.pending.behind).toBe(false);
});

test("deleting echoed text hides it at once, typing after lands right", async () => {
  const { echo, server, erase } = setup("$ ");
  echo.key("l");
  await sleep(40);
  server("l", 2);
  echo.key("s");
  await sleep(40);
  server("s", 3);
  echo.key("\x7f");
  echo.key("\x7f");
  echo.key("w");
  expect(echo.pending).toMatchObject({ x: 2, text: "w" });
  erase(3);
  erase(2);
  server("w", 2);
  expect(echo.visible()).toBe(false);
});
