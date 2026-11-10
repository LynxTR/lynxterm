import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const script = readFileSync(new URL("../../../services/ssh.sh", import.meta.url), "utf8");

// Fake server in temp dir: sudo/sshd/systemctl/uname stubbed on PATH. Stub sshd -t fails on
// config saying BROKEN; -T reports first PasswordAuthentication. Stub sleep kills its parent,
// the undo timer, so it never fires; timer tests use real sleep (WAIT cut to 0.3s).
function server(config: (d: string) => string, dropIns: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "lynxterm-ssh-"));
  for (const dir of ["sshd_config.d", "bin", "home/.ssh"])
    mkdirSync(join(d, dir), { recursive: true });
  const conf = join(d, "sshd_config");
  writeFileSync(conf, config(d));
  for (const [name, text] of Object.entries(dropIns))
    writeFileSync(join(d, "sshd_config.d", name), text);
  const stub = (name: string, body: string) => {
    writeFileSync(join(d, "bin", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(d, "bin", name), 0o755);
  };
  stub("sudo", '[ "$1" = -n ] && shift\nexec "$@"');
  stub("uname", "echo Linux");
  stub("systemctl", "exit 0");
  stub("sleep", "kill $PPID");
  stub(
    "sshd",
    `case $1 in
  -t) ! grep -q BROKEN "${conf}" ;;
  -T) awk 'tolower($1) == "passwordauthentication" { print "passwordauthentication", tolower($2); exit }' "${conf}" ;;
esac`,
  );
  const run = (fn: string, auth = "publickey", env: Record<string, string> = {}) => {
    const r = spawnSync("sh", ["-s", fn], {
      input: script
        .replace("CONF=/etc/ssh/sshd_config", `CONF=${conf}`)
        .replace("WAIT=120", "WAIT=0.3"),
      env: {
        PATH: `${d}/bin:${process.env.PATH}`,
        HOME: join(d, "home"),
        LYNXTERM_AUTH: auth,
        ...env,
      },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout.trim() };
  };
  const keys = () => writeFileSync(join(d, "home/.ssh/authorized_keys"), "ssh-ed25519 AAAA me\n");
  const pending = join(d, "home/.lynxterm/ssh-key-only.pending");
  return { d, conf, run, keys, stub, pending, read: () => readFileSync(conf, "utf8") };
}

const ubuntu = (d: string) =>
  `# sshd config\nInclude ${d}/sshd_config.d/*.conf\nPort 2222\nKbdInteractiveAuthentication no\n`;

test("check reads Include files where they sit, first value wins", () => {
  expect(
    server(ubuntu, { "50-cloud-init.conf": "PasswordAuthentication no\n" }).run("check"),
  ).toEqual({
    code: 0,
    out: "Key only, passwords off",
  });
  const s = server((d) => `${ubuntu(d)}PasswordAuthentication no\n`, {
    "50-cloud-init.conf": "PasswordAuthentication yes\n",
  });
  expect(s.run("check")).toEqual({ code: 1, out: "Password sign-in on" });
  expect(server(ubuntu).run("check").code).toBe(1); // unset: sshd's default is yes
  expect(
    server((d) => `Match User git\n  PasswordAuthentication no\n${ubuntu(d)}`).run("check").code,
  ).toBe(1);
});

test("fix refuses unless this session signed in with a key", () => {
  const s = server(ubuntu);
  s.keys();
  const before = s.read();
  expect(s.run("fix", "password").code).toBe(2);
  expect(s.read()).toBe(before);
  const noKeys = server(ubuntu);
  const untouched = noKeys.read();
  expect(noKeys.run("fix").out).toContain("No key in ~/.ssh/authorized_keys");
  expect(noKeys.read()).toBe(untouched);
});

test("fix puts block on top once, keeps a backup; uninstall takes only it out", () => {
  const s = server(ubuntu, { "50-cloud-init.conf": "PasswordAuthentication yes\n" });
  s.keys();
  const before = s.read();
  expect(s.run("fix").code).toBe(0);
  expect(s.read().startsWith("# >>> lynxterm key-only sign-in\nPasswordAuthentication no\n")).toBe(
    true,
  );
  expect(s.read()).toContain("KbdInteractiveAuthentication no\nChallengeResponseAuthentication no");
  expect(s.read()).toContain("Port 2222");
  expect(readFileSync(`${s.conf}.before-lynxterm`, "utf8")).toBe(before);
  // Reused connection inside the undo window: off, but not called done.
  expect(s.run("check")).toEqual({
    code: 1,
    out: "Off, but not confirmed yet: undone by itself unless a new sign-in with your key works",
  });
  // New key sign-in: confirmed, and block beats drop-in saying yes.
  expect(s.run("check", "publickey", { LYNXTERM_FRESH: "1" }).code).toBe(0);
  expect(s.run("check").code).toBe(0);
  // Second run inside the undo window: refused, backup the timer restores stays intact.
  const again = s.run("fix");
  expect(again.code).toBe(2);
  expect(again.out).toContain("moment ago");
  expect(s.read().match(/>>> lynxterm/g)).toHaveLength(1);
  expect(s.run("uninstall").code).toBe(0);
  expect(s.read()).toBe(before);
  expect(s.run("check").code).toBe(1);
});

test("config sshd rejects is put back", () => {
  const s = server((d) => `${ubuntu(d)}# BROKEN\n`);
  s.keys();
  const before = s.read();
  const r = s.run("fix");
  expect(r.code).toBe(2);
  expect(r.out).toContain("back as it was");
  expect(s.read()).toBe(before);
  expect(existsSync(`${s.conf}.before-lynxterm`)).toBe(true);
});

test("keyboard-interactive counts as password sign-in; key=value is read", () => {
  expect(server(() => "PasswordAuthentication no\nUsePAM yes\n").run("check").code).toBe(1);
  const s = server(() => "PasswordAuthentication=no\nKbdInteractiveAuthentication = no\n");
  expect(s.run("check")).toEqual({ code: 0, out: "Key only, passwords off" });
});

test("Match rule still allowing passwords is reported, not called done", () => {
  const s = server(() => "Port 22\nMatch User bob\n  PasswordAuthentication yes\n");
  s.keys();
  const r = s.run("fix");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Match rule");
  expect(s.run("check").code).toBe(1);
});

test("short write is put back", () => {
  const s = server(ubuntu);
  s.keys();
  s.stub("cmp", "exit 1");
  const before = s.read();
  expect(s.run("fix").code).toBe(2);
  expect(s.read()).toBe(before);
});

test("root without sudo (Proxmox) still works", () => {
  const s = server(ubuntu);
  s.keys();
  s.stub("id", '[ "$1" = -u ] && echo 0 || /usr/bin/id "$@"');
  s.stub("sudo", "echo sudo used; exit 1");
  expect(s.run("fix").code).toBe(0);
  expect(s.read()).toContain("PasswordAuthentication no");
});

test("sshd that doesn't reload: config put back", () => {
  const s = server(ubuntu);
  s.keys();
  s.stub("systemctl", "exit 1");
  const before = s.read();
  const r = s.run("fix");
  expect(r.code).toBe(2);
  expect(r.out).toContain("didn't reload");
  expect(s.read()).toBe(before);
});

test("relative and nested Include are read; config only root reads is unknown", () => {
  const s = server(() => "Include sshd_config.d/*.conf\nPort 22\n", {
    "10-more.conf": "Include extra\n",
  });
  writeFileSync(join(s.d, "extra"), "PasswordAuthentication no\nKbdInteractiveAuthentication no\n");
  expect(s.run("check").code).toBe(0);
  if (process.getuid?.() === 0) return; // root reads anything
  chmodSync(s.conf, 0o000);
  expect(s.run("check").code).toBe(3);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("undo timer: passwords back unless a new key sign-in confirms", async () => {
  const s = server(ubuntu);
  s.keys();
  s.stub("sleep", 'exec /bin/sleep "$@"');
  const before = s.read();
  expect(s.run("fix").code).toBe(0);
  expect(s.read()).toContain("PasswordAuthentication no");
  // Reused connection, or password sign-in on a new one: no proof the key gets in.
  s.run("check");
  s.run("check", "password", { LYNXTERM_FRESH: "1" });
  await wait(1200);
  expect(s.read()).toBe(before);
  expect(existsSync(s.pending)).toBe(false);
});

test("undo timer stands down after a new key sign-in", async () => {
  const s = server(ubuntu);
  s.keys();
  s.stub("sleep", 'exec /bin/sleep "$@"');
  expect(s.run("fix").code).toBe(0);
  expect(s.run("check", "publickey", { LYNXTERM_FRESH: "1" }).code).toBe(0);
  await wait(1200);
  expect(s.read()).toContain("PasswordAuthentication no");
  expect(existsSync(s.pending)).toBe(false);
});

test("allowing passwords again inside the undo window sticks", async () => {
  const s = server(ubuntu);
  s.keys();
  s.stub("sleep", 'exec /bin/sleep "$@"');
  const before = s.read();
  expect(s.run("fix").code).toBe(0);
  expect(s.run("uninstall").code).toBe(0);
  await wait(1200);
  expect(s.read()).toBe(before);
});

test("change that can't be read back is undone, not left without a timer", () => {
  const s = server(ubuntu);
  s.keys();
  // sudo cat works once (reading config to edit), then fails (reading result back).
  s.stub(
    "sudo",
    `if [ "$1" = cat ]; then n=$(cat ${s.d}/n 2>/dev/null || echo 0); echo $((n + 1)) > ${s.d}/n; [ "$n" -lt 1 ] || exit 1; fi\nexec "$@"`,
  );
  const before = s.read();
  const r = s.run("fix");
  expect(r.code).toBe(2);
  expect(r.out).toContain("back as it was");
  expect(s.read()).toBe(before);
  expect(existsSync(s.pending)).toBe(false);
});
