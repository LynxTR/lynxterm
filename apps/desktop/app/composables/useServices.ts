import { invoke } from "@tauri-apps/api/core";

/** Built-in services, bundled from /services, with ids like builtin:node. Usable on any host
 *  as they are; a copy saved from the Services page becomes the user's own (same name hides
 *  the built-in) and can be tuned. */
export const serviceTemplates = Object.entries(
  import.meta.glob<string>("../../../../services/*.sh", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)
  .flatMap(([path, text]) => {
    const s = serviceFromFile(text);
    if ("error" in s) return [];
    return [{ ...s, id: `builtin:${path.split("/").pop()!.replace(/\.sh$/, "")}` }];
  })
  .sort((a, b) => a.name.localeCompare(b.name));
export const isBuiltIn = (s: { id?: string }) => !!s.id?.startsWith("builtin:");

const services = ref<Service[]>([]);
/** Own services, then built-ins not shadowed by an own one of the same name. */
const available = computed(() => [
  ...services.value,
  ...serviceTemplates.filter((t) => !services.value.some((s) => s.name === t.name)),
]);

export function useServices() {
  const refresh = async () => {
    services.value = (await invoke<Service[]>("services_list")).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  };
  /** Resolves to id; new one for new service. */
  const save = (service: Service) =>
    invoke<string>("service_save", { service }).then((id) => refresh().then(() => id));
  const remove = (id: string) => invoke("item_delete", { id }).then(refresh);
  return { services, available, refresh, save, remove };
}

/** missing: detect says not installed. Rest from check's exit code. */
export type Health = "ok" | "warn" | "crit" | "unknown" | "missing";
interface ServiceHealth {
  health: Health;
  /** check's first line, or why it couldn't run. */
  summary: string;
  /** detect's first line, like "Docker version 27.3.1". */
  version: string;
  /** Newer version, from detect's update: line. */
  update: string;
  at: number;
}

/** Latest results by host id, then service id. Memory only: checked again on connect. */
const health = ref<Record<string, Record<string, ServiceHealth>>>({});
/** Host ids being checked now. */
const checking = ref(new Set<string>());

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const run = (h: SavedHost, serviceId: string, fn: "detect" | "preflight" | "check") =>
  invoke<{ code: number; output: string }>("service_run", {
    serviceId,
    function: fn,
    session: useSessions().sessionFor(h) ?? null,
    hostId: h.id,
    auth: h.keyId ? "publickey" : "password",
  });

async function checkOne(h: SavedHost, s: Service): Promise<ServiceHealth> {
  const at = Date.now();
  const result = (health: Health, summary: string, version = "", update = "") => ({
    health,
    summary,
    version,
    update,
    at,
  });
  try {
    const d = await run(h, s.id!, "detect");
    if (d.code !== 0) return result("missing", "Not installed");
    const version = firstLine(d.output);
    const update = d.output.match(/^update: (.*)$/m)?.[1] ?? "";
    if (s.functions.check === undefined) return result("ok", "Installed", version, update);
    const c = await run(h, s.id!, "check");
    const health = (["ok", "warn", "crit"] as const)[c.code] ?? "unknown";
    return result(health, firstLine(c.output), version, update);
  } catch (e) {
    return result("unknown", String(e));
  }
}

/** detect, then check, for each service (or `only` ones), one at a time over one connection:
 *  open terminal, else host's background one (needs a key or saved password). */
export async function checkHost(h: SavedHost, only?: (s: Service) => boolean) {
  const list = useServices().available.value.filter((s) => !only || only(s));
  if (!list.length || checking.value.has(h.id!)) return [];
  checking.value.add(h.id!);
  // Background connection opened only for this: closed after, as monitoring does.
  const own = useSessions().sessionFor(h) === undefined && !isWatched(h);
  const done: { service: Service; result: ServiceHealth; before?: Health }[] = [];
  try {
    for (const s of list) {
      const before = health.value[h.id!]?.[s.id!]?.health;
      const result = reachable(h)
        ? await checkOne(h, s)
        : {
            health: "unknown" as const,
            summary: "Open a terminal to it first",
            version: "",
            update: "",
            at: Date.now(),
          };
      health.value[h.id!] = { ...health.value[h.id!], [s.id!]: result };
      done.push({ service: s, result, before });
    }
  } finally {
    checking.value.delete(h.id!);
    if (own) invoke("metrics_unwatch", { hostId: h.id }).catch(() => {});
  }
  return done;
}

/** Install, fix, upgrade, logs, uninstall: in a new terminal tab, where sudo can ask. Install,
 *  upgrade and fix change the server: preflight first when LynxTerm can (blocked stops,
 *  warnings ask). Uninstall always asks. Checked again when the tab's command ends. */
export async function runAction(h: SavedHost, s: Service, fn: ServiceFunction) {
  const toast = useToast();
  const changes = fn === "install" || fn === "upgrade" || fn === "fix";
  if (changes && s.functions.preflight !== undefined && reachable(h)) {
    const p = await run(h, s.id!, "preflight").catch(() => undefined);
    const found = p?.output.trim() ?? "";
    if (p?.code === 2)
      return void toast.add({ title: `Can't ${fn} ${s.name}`, description: found, color: "error" });
    if (p?.code === 1) {
      const verb = fn === "fix" ? s.fixLabel || "Fix" : fn === "install" ? "Install" : "Upgrade";
      const ok = await askConfirm({
        title: `${verb}: ${s.name} on ${hostName(h)}?`,
        description: "Preflight found something to know first.",
        detail: found,
        label: verb,
      });
      if (!ok) return;
    }
  }
  if (fn === "uninstall") {
    const ok = await askConfirm({
      title: `Uninstall ${s.name} from ${hostName(h)}?`,
      description: "Runs its uninstall in a terminal. What it removes depends on the service.",
      detail: health.value[h.id!]?.[s.id!]?.summary,
      label: "Uninstall",
    });
    if (!ok) return;
  }
  let command: string;
  try {
    command = await invoke<string>("service_command", {
      serviceId: s.id,
      function: fn,
      auth: h.keyId ? "publickey" : "password",
    });
  } catch (e) {
    return void toast.add({
      title: `Couldn't start ${fn}`,
      description: String(e),
      color: "error",
    });
  }
  const pane = useSessions().runOn(h, command, `${fn} ${s.name}`);
  let started = false;
  const stop = watch(
    () => [pane.session, pane.state] as const,
    ([session, state]) => {
      if (session !== undefined) started = true;
      if (state !== "closed") return;
      stop();
      if (!started) return; // never connected: tab says why
      logActivity(h, { kind: "service", title: `Ran ${fn} of ${s.name}` });
      void checkHost(h, (x) => x.id === s.id);
    },
  );
}

/** Open terminal, or background connection with a key or saved password. */
const reachable = (h: SavedHost) =>
  useSessions().sessionFor(h) !== undefined || !!h.keyId || !!h.savedPassword;

const RANK: Health[] = ["missing", "ok", "unknown", "warn", "crit"];
export function useServiceHealth(hostId: () => string | undefined) {
  const results = computed(() => health.value[hostId() ?? ""] ?? {});
  /** Worst result among current services, for hosts list. */
  const worst = computed(() =>
    useServices()
      .available.value.map((s) => results.value[s.id!])
      .reduce<ServiceHealth | undefined>(
        (w, r) => (r && (!w || RANK.indexOf(r.health) > RANK.indexOf(w.health)) ? r : w),
        undefined,
      ),
  );
  const busy = computed(() => checking.value.has(hostId() ?? ""));
  return { results, worst, busy };
}

/** Check on connect: when a terminal connects to a saved host. Check every: on each host
 *  LynxTerm can reach, while it runs; where detect said not installed, once a day instead.
 *  Toast for warning or critical: always on connect, only on change when scheduled. */
export function startServiceChecks() {
  const toast = useToast();
  async function checkAndTell(h: SavedHost, only: (s: Service) => boolean, onChange: boolean) {
    for (const { service, result, before } of await checkHost(h, only)) {
      if (result.health !== "warn" && result.health !== "crit") continue;
      if (onChange && before === result.health) continue;
      toast.add({
        title: `${service.name} on ${hostName(h)}: ${result.summary}`,
        description: service.why || undefined,
        color: result.health === "crit" ? "error" : "warning",
        icon: "i-ph-warning-circle-duotone",
      });
    }
  }

  const seen = new Set<number>();
  watch(
    () =>
      useSessions()
        .tabs.value.flatMap((t) => t.panes)
        .filter((p) => p.session !== undefined && !p.target.command && !seen.has(p.session)),
    (panes) => {
      for (const p of panes) {
        seen.add(p.session!);
        const h = useHosts().hosts.value.find((x) => hostKey(x) === hostKey(p.target));
        if (!h) continue;
        void (async () => {
          await checkAndTell(h, (s) => s.checkOnConnect, false);
          // A connection is a cheap chance to fill in what was never checked here.
          await checkHost(h, (s) => {
            const r = health.value[h.id!]?.[s.id!];
            return !r || r.health === "unknown";
          });
        })();
      }
    },
  );

  // Once a minute: services due on each host. ponytail: app-side timer, nothing runs while
  // LynxTerm is closed; a cron job on the server if that matters.
  setInterval(() => {
    for (const h of useHosts().hosts.value) {
      if (!reachable(h)) continue;
      const due = (s: Service) => {
        const last = health.value[h.id!]?.[s.id!];
        const every = last?.health === "missing" ? Math.max(s.checkEvery, 1440) : s.checkEvery;
        return s.checkEvery > 0 && Date.now() - (last?.at ?? 0) >= every * 60_000;
      };
      if (useServices().available.value.some(due)) void checkAndTell(h, due, true);
    }
  }, 60_000);
}
