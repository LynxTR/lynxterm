import { expect, test } from "vite-plus/test";
import { figComplete } from "../app/composables/fig";

// Specs load on first use, so cases that need one poll.
const complete = (line: string) => figComplete(line, () => {}).map((c) => c.text);

test("subcommands, options and loadSpec", async () => {
  await expect.poll(() => complete("git chec")).toContain("git checkout");
  await expect.poll(() => complete("sudo git chec")).toContain("sudo git checkout");
  await expect.poll(() => complete("git commit --am")).toContain("git commit --amend");
  // -m takes value: "x" not a subcommand
  await expect.poll(() => complete("git commit -m x --am")).toContain("git commit -m x --amend");
  await expect.poll(() => complete("dotnet add pack")).toContain("dotnet add package"); // loadSpec
  expect(complete("nosuchcommand x")).toEqual([]);
  expect(complete("git")).toEqual([]); // command itself comes from PATH
});
