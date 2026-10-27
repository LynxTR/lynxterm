// Dev only, plain browser (no Tauri): answer commands with sample data to check layouts at
// any width. Never active inside app.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

export default defineNuxtPlugin(() => {
  if (!import.meta.dev || "__TAURI_INTERNALS__" in window) return;
  mockWindows("main");

  const key = (id: string, name: string, rev: number) => ({
    id,
    name,
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:Xq4nV7m0cB1yL9r2Kd8sT3wPz6aHf5eJ0uGiN4oQkEw",
    publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOq7r2h2Lw ${name}@lynxterm`,
    createdAt: 1772409600,
    origin: "generated",
    rev,
    dirty: rev === 0,
  });
  const host = (
    id: string,
    name: string,
    group: string,
    user: string,
    ip: string,
    os = "",
    tags: string[] = [],
  ) => ({ id, name, group, host: ip, port: 22, user, keyId: "k1", os, tags });
  const shells: ((typed: string) => void)[] = []; // by session id
  // ?vault=none: first run (welcome, vault, sync, hosts). ?vault=locked: unlock screen.
  const params = new URLSearchParams(location.search);
  const vault = params.get("vault");
  const firstRun = vault === "none";
  let signedOut = params.has("signedOut");
  // ?groups=5,4,3: groups of those sizes replace sample hosts; &ungrouped=2 adds ungrouped
  // ones. Checks how Hosts grid fits them.
  const sizes = params
    .get("groups")
    ?.split(",")
    .map(Number)
    .filter((n) => n > 0);
  const palette = [
    ["production", "#ff8a8a"],
    ["staging", "#6cb6ff"],
    ["homelab", "#2dd4bf"],
    ["customers", "#c084fc"],
    ["edge", "#ffb020"],
    ["backups", "#3ddc97"],
  ] as const;
  const sized = sizes && {
    groups: sizes.map((_, g) => ({
      id: `g${g}`,
      name: palette[g % 6]![0],
      color: palette[g % 6]![1],
      order: g,
    })),
    hosts: [
      ...sizes.flatMap((n, g) =>
        Array.from({ length: n }, (_, i) => {
          const group = palette[g % 6]![0];
          return host(
            `h${g}-${i}`,
            `${group.slice(0, 4)}-${i + 1}`,
            group,
            "deploy",
            `10.0.${g}.${i + 10}`,
            "ubuntu",
          );
        }),
      ),
      ...Array.from({ length: Number(params.get("ungrouped")) || 0 }, (_, i) =>
        host(`u${i}`, `spare-${i + 1}`, "", "root", `10.9.0.${i + 10}`, "debian"),
      ),
    ],
  };
  type Item = Record<string, unknown>;
  const upsert = (listKey: string, item: Item, idPrefix: string) => {
    const list = data[listKey] as Item[];
    const saved = { ...item, id: item.id || `${idPrefix}${Date.now()}${Math.random()}` };
    const i = list.findIndex((x) => item.id && x.id === item.id);
    if (i >= 0) list[i] = saved;
    else list.push(saved);
  };
  const data: Record<string, unknown> = {
    vault_status: vault === "none" || vault === "locked" ? vault : "unlocked",
    vault_create: "K7Q4-M2XJ-9P3R-T8NV-5WCD-H6LB-Z1YF-A4EG",
    sync_url: firstRun ? null : "https://lynxterm-vault.you.workers.dev",
    sync_connect: ({ url }: { url: string }) => {
      data.sync_url = url;
      data.sync_skipped = [];
    },
    vault_join: ({ url }: { url: string }) => {
      data.sync_url = url;
    },
    ssh_config_hosts: (
      [
        ["prod-web-01", "10.0.4.21", 22, "deploy", "~/.ssh/deploy"],
        ["db-primary", "10.0.4.30", 22, "root", "~/.ssh/deploy"],
        ["prod-db-01", "10.0.4.31", 2222, "ops", "~/.ssh/deploy"],
        ["homelab-pi", "192.168.1.40", 22, "pi", "~/.ssh/homelab"],
        ["github", "github.com", 22, "git", "~/.ssh/id_ed25519"],
      ] as const
    ).map(([name, ip, port, user, identityFile]) => ({ name, host: ip, port, user, identityFile })),
    key_import: ({ name }: { name: string }) =>
      name === "homelab" ? Promise.reject("needs a passphrase") : `k-${name}`,
    host_save: ({ host }: { host: Item }) => upsert("hosts_list", host, "h"),
    group_save: ({ group }: { group: Item }) => upsert("groups_list", group, "g"),
    keys_list: firstRun
      ? []
      : [key("k1", "deploy-2026", 1795), key("k2", "homelab", 1802), key("k3", "github", 0)],
    keys_scan: ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"],
    hosts_list: firstRun
      ? []
      : sized
        ? sized.hosts
        : [
            host("h1", "api-prod-1", "production", "deploy", "10.0.4.12", "ubuntu", [
              "nginx",
              "node",
            ]),
            host("h2", "api-prod-2", "production", "deploy", "10.0.4.13", "ubuntu", ["nginx"]),
            host("h3", "db-primary", "production", "postgres", "10.0.5.2", "debian", ["postgres"]),
            host("h4", "nas.local", "homelab", "admin", "192.168.1.20"),
            host("h5", "proxmox", "homelab", "root", "192.168.1.10", "debian"),
          ],
    groups_list: firstRun
      ? []
      : sized
        ? sized.groups
        : [
            { id: "g1", name: "production", color: "#ff8a8a" },
            { id: "g2", name: "homelab", color: "#2dd4bf" },
          ],
    snippets_list: [
      { id: "s1", name: "Tail app logs", command: "docker compose logs -f --tail 100" },
      { id: "s2", name: "Disk usage", command: "df -h" },
    ],
    forwards_list: [
      {
        id: "f1",
        name: "Postgres",
        hostId: "h3",
        localPort: 5432,
        remoteHost: "127.0.0.1",
        remotePort: 5432,
      },
    ],
    forwards_running: ["f1"],
    known_hosts_list: [
      {
        line: 1,
        hosts: "github.com",
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
      },
      {
        line: 2,
        hosts: "",
        algorithm: "ecdsa-sha2-nistp256",
        fingerprint: "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
      },
    ],
    history_list: [
      {
        hostKey: "deploy@10.0.4.12:22",
        commands: ["cd /srv/app", "docker compose ps", "docker compose logs -f api", "git pull"],
      },
      { hostKey: "root@203.0.113.7:2222", commands: ["htop", "journalctl -u nginx -f"] },
    ],
    sync_skipped: ["history"],
    // "wrong" is the only wrong master password; restart lands on first run.
    vault_erase: ({ password }: { password: string }) => {
      if (password === "wrong") throw "Wrong master password";
    },
    app_restart: () => location.assign("/?vault=none"),
    "plugin:app|version": "0.1.0",
    latest_release: {
      system: "Linux, x86_64",
      latest: {
        version: "0.2.0",
        url: "https://github.com/LynxTR/lynxterm/releases/tag/v0.2.0",
        download: {
          name: "Lynxterm_0.2.0_amd64.deb",
          url: "https://github.com/LynxTR/lynxterm/releases/download/v0.2.0/Lynxterm_0.2.0_amd64.deb",
          kind: ".deb package",
        },
      },
    },
    sync_pending: [],
    sync_status: {
      devices: Number(params.get("devices") ?? 2),
      newDevices: params.get("newDevices") !== "off",
    },
    // ?signedOut: master password changed on another device; sync fails until sign-in
    // ("wrong" is wrong password).
    sync_now: () => {
      if (signedOut) throw "Signed out: the master password was changed on another device";
      return false;
    },
    sync_sign_in: ({ password }: { password: string }) => {
      if (password === "wrong") throw "Wrong master password";
      signedOut = false;
    },
    // Shell that echoes and answers setup line like real hooks (shell-integration.sh), to try
    // typing, suggestions, command blocks. "false" fails, "sleep" is slow. Starship-style
    // prompt checks Nerd Font icons.
    ssh_open: ({ onData }: { onData: Channel<ArrayBuffer> }) => {
      const echo = (text: string) =>
        onData.onmessage(new TextEncoder().encode(text).buffer as ArrayBuffer);
      const osc = (s: string) => `\x1b]${s}\x07`;
      const prompt =
        "\x1b[30;44m \uf07c ~/app \x1b[34;43m\ue0b0\x1b[30m \ue725 main \x1b[0;33m\ue0b0" +
        "\x1b[0m  via \x1b[33m\ue718 v20.16.0\x1b[0m\r\n\x1b[32m\u276f\x1b[0m ";
      const hooked = (end: string, header = true) =>
        end +
        osc("633;P;Branch=main") +
        (header ? `${osc("633;H")}\r\n` : "") +
        `${osc("133;A")}${prompt}${osc("133;B")}`;
      let setUp = false;
      let line = "";
      const id = shells.length + 1;
      shells[id] = (typed: string) => {
        if (typed.startsWith(" [ -n")) {
          setUp = true;
          return echo(`${typed}\n${osc("633;Ready;1")}${hooked(osc("133;D"))}`);
        }
        if (typed.startsWith("\x1b[")) return; // xterm answering query below
        if (typed === "\x7f") return echo(((line = line.slice(0, -1)), "\b \b"));
        if (typed !== "\r") return echo(((line += typed), typed));
        const cmd = line.trim();
        line = "";
        if (!setUp) return echo(`\r\n${prompt}`);
        if (!cmd) return echo(`\r\n${hooked(osc("133;D"), false)}`);
        const status = cmd === "false" ? 1 : 0;
        echo(`\r\n${osc("133;C")}${status ? "" : `${cmd}: done\r\n`}`);
        setTimeout(
          () => echo(hooked(`${osc(`133;D;${status}`)}\r\n`)),
          cmd === "sleep" ? 1500 : 40,
        );
      };
      // Some logins ask terminal for cursor position; xterm answers by itself.
      setTimeout(() => echo(`\x1b[6n${prompt}`));
      return id;
    },
    ssh_write: ({ id, data: typed }: { id: number; data: string }) => shells[id]?.(typed),
    ssh_commands: ["git", "docker", "systemctl", "journalctl", "dotnet"],
    sftp_list: ({ path }: { path: string }) => {
      const dir = (name: string) => ({ name, isDir: true, size: 0 });
      const at = path || "/root";
      return at === "/"
        ? { path: at, entries: ["bin", "etc", "home", "root", "usr", "var"].map(dir) }
        : {
            path: at,
            entries: [dir("app"), { name: ".bashrc", isDir: false, size: 3771 }],
          };
    },
    // 7 days of one-a-minute history with 3-hour gap (server off); live sample each second.
    metrics: ({ action }: { action: string }) => {
      const now = Math.floor(Date.now() / 1000);
      const line = (t: number) => {
        const day = Math.sin((t / 86400) * 2 * Math.PI);
        const cpu = Math.round(
          Math.min(100, 25 + 20 * day + Math.random() * 15 + (Math.random() < 0.01 ? 50 : 0)),
        );
        const load = ((cpu / 100) * 4 * (0.8 + Math.random() * 0.4)).toFixed(2);
        const rx = Math.round(400_000 + 1_200_000 * Math.random() * (1 + day));
        const tx = Math.round(rx * (0.15 + Math.random() * 0.2));
        return `${t} ${cpu} ${Math.round(3000 + 900 * day + Math.random() * 200)} 7900 ${62 + Math.floor((t - now + 604800) / 200000)} ${load} 4 ${rx} ${tx}`;
      };
      if (action === "sample") return new Promise((r) => setTimeout(() => r(line(now)), 1000));
      if (action !== "history") return "";
      const lines = ["on"];
      for (let t = now - 604800; t < now; t += 60)
        if (now - t < 86400 * 2 || now - t > 86400 * 2 + 10800) lines.push(line(t));
      return lines.join("\n");
    },
    metrics_host: ({ hostId, action }: { hostId: string; action: string }) =>
      hostId === "h4"
        ? Promise.reject("unreachable")
        : (data.metrics as (a: { action: string }) => unknown)({ action }),
    activity_list: () => {
      const now = Math.floor(Date.now() / 1000);
      return [
        {
          at: now - 86400 * 5,
          kind: "integration",
          title: "Shell integration install failed",
          detail: "The server said (exit 1): permission denied",
          ok: false,
        },
        {
          at: now - 86400 * 3,
          kind: "monitoring",
          title: "Turned on monitoring history",
          detail: "cron job, ~/.lynxterm/metrics",
          ok: true,
        },
        {
          at: now - 86400,
          kind: "key",
          title: "Installed key deploy-2026",
          detail: "added to ~/.ssh/authorized_keys",
          ok: true,
        },
        {
          at: now - 3600,
          kind: "upload",
          title: "Uploaded release.tar.gz",
          detail: "to /srv/app",
          ok: true,
        },
        {
          at: now - 120,
          kind: "snippet",
          title: "Ran snippet Tail app logs",
          detail: "docker compose logs -f --tail 100",
          ok: true,
        },
      ];
    },
  };
  mockIPC((cmd, args) => {
    const value = data[cmd];
    // Copy, like real IPC: same array would hide changes from Vue.
    return typeof value === "function" ? value(args) : structuredClone(value ?? null);
  });
});
