import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";

const read = (name: string) =>
  readFileSync(new URL(`../src-tauri/src/${name}`, import.meta.url), "utf8");
const hooks = read("shell-integration.sh") + read("shell-integration-session.sh");
const hasBash = spawnSync("bash", ["--version"]).status === 0;

// Block old Terminal settings added to ~/.bashrc; already loaded when hooks typed in.
const OLD_INSTALL = `PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND;}__lynxterm_prompt"; PS0=$'\\033]133;C\\007'`;

test.skipIf(!hasBash).each(["", OLD_INSTALL])("bash reports status and folder %#", (before) => {
  // stderr too: bash prints prompts there, PS0 included
  const { stdout } = spawnSync("bash", ["-c", "exec bash --norc --noprofile -i 2>&1"], {
    input: `${before}\n${hooks}\nfalse\ncd /tmp\nexit\n`,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: "/root",
      PS1: "$ ",
      PROMPT_COMMAND: "echo theme-saw=$?",
    },
  });
  const after = stdout.slice(stdout.indexOf("\x1b]633;Ready;0\x07"));
  expect(after).not.toBe("");
  const failed = after.indexOf("\x1b]133;D;1\x07");
  expect(failed).toBeGreaterThan(0);
  expect(after.indexOf("theme-saw=1")).toBeGreaterThan(0); // $? survives for prompt themes
  expect(after.indexOf("/tmp\x07")).toBeGreaterThan(failed);
  expect(after).not.toContain("\x1b]633;H");
  expect(after.match(/\x1b\]133;C\x07/g)?.length).toBe(4); // setup's last line, false, cd, exit
});
