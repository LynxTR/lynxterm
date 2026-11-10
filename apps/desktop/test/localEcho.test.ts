import { expect, test } from "vite-plus/test";
import { localEcho } from "../app/composables/localEcho";

/** One-row screen; server "echoes" by writing into it. */
function setup(prompt: string, unsafe = false) {
  const row: string[] = [...prompt];
  const echo = localEcho({
    cols: 80,
    cursor: () => ({ x: row.length, y: 0 }),
    cell: (x) => row[x] ?? "",
    restBlank: () => true,
    unsafe: () => unsafe,
  });
  const server = (text: string, at: number) => {
    row.splice(at, text.length, ...text);
    echo.settle();
  };
  return { echo, server };
}

test("grey only after server echoed a key on this line, then confirmed away", async () => {
  const { echo, server } = setup("$ ");
  echo.key("l");
  expect(echo.visible()).toBe(false); // line not known to echo yet
  await new Promise((r) => setTimeout(r, 40)); // slow link
  server("l", 2);
  echo.key("s");
  echo.key(" ");
  expect(echo.visible()).toBe(true);
  expect(echo.pending.text).toBe("s ");
  server("s", 3);
  expect(echo.pending).toMatchObject({ text: " ", x: 4 });
  echo.key("\x7f");
  expect(echo.visible()).toBe(false); // nothing pending
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
  expect(echo.visible()).toBe(true); // caret stays after "b"
  expect(echo.waiting()).toBe(true);
  await new Promise((r) => setTimeout(r, 40));
  server("b", 3); // echoed, newline not yet
  expect(echo.waiting()).toBe(true);
  server("\n", 4); // cursor moves on
  expect(echo.waiting()).toBe(false);
  expect(echo.pending.text).toBe("");
});
