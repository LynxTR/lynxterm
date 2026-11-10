import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  lintServiceFile,
  parseServiceFile,
  serviceFile,
  serviceFromFile,
} from "../app/composables/serviceFile";

const dir = new URL("../../../services/", import.meta.url);

for (const name of readdirSync(dir).filter((f) => f.endsWith(".sh"))) {
  test(`service ${name}`, () => {
    const text = readFileSync(new URL(name, dir), "utf8").trimEnd();
    const parts = parseServiceFile(text);
    if ("error" in parts) throw new Error(`line ${parts.line}: ${parts.error}`);
    expect(serviceFile(parts)).toBe(text);
    expect(lintServiceFile(text)).toEqual([]);
    execFileSync("sh", ["-n"], { input: text });

    const service = serviceFromFile(text);
    if ("error" in service || !service.name) throw new Error("no # name: line");
    expect(service.shared).not.toMatch(/^# (name|description|why|fix):/m);
  });
}
