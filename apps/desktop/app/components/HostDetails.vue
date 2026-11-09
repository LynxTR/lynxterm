<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import type { DropdownMenuItem } from "@nuxt/ui";
// Explicit (not auto-imported): defineProps resolves only imported types to runtime Object.
import type { SavedHost } from "~/composables/useHosts";

const props = defineProps<{ host: SavedHost; menu: DropdownMenuItem[][] }>();
const emit = defineEmits<{ connect: [] }>();
const { sessionFor } = useSessions();
const { keys } = useKeys();
const { knownHosts } = useKnownHosts();
const settings = useSettings();

const stream = computed(() => liveOf(props.host));
const alerts = computed(() => alertsFor(props.host));
const open = computed(() => sessionFor(props.host) !== undefined);
// Monitoring card: charts while streaming (watched or terminal open), else why not.
const monitoring = computed(() => {
  if (open.value || isWatched(props.host)) return "charts";
  return props.host.keyId ? "off" : "password";
});

const status = computed(() => {
  if (alerts.value.length) {
    const a = alerts.value[0]!;
    const label = a.metric === "unreachable" ? "no answer" : `${a.label} at ${a.value}`;
    return { label, tone: "text-error ring-error/40" };
  }
  if (stream.value?.error) return { label: "no answer", tone: "text-error ring-error/40" };
  if (monitoring.value === "off") return { label: "not watched", tone: "" };
  if (monitoring.value === "password") return { label: "password", tone: "" };
  if (stream.value?.samples.length)
    return { label: "online", tone: "text-success ring-success/30" };
  return { label: "connecting", tone: "" };
});

async function forgetPassword() {
  const { host, port, user } = props.host;
  const ok = await askConfirm({
    title: `Forget the password for ${hostName(props.host)}?`,
    description:
      "Removes it here and on your synced devices. The next connection asks for it again.",
    detail: hostLabel(props.host),
    label: "Forget",
  });
  if (!ok) return;
  shown.value = "";
  await invoke("host_password_save", { host, port, user, password: "" });
  await useHosts().refresh();
}

// Master password first, like key export. Hidden again on eye or other host.
const revealOpen = ref(false);
const master = ref("");
const shown = ref("");
const revealing = ref(false);
watch(
  () => props.host.id,
  () => (shown.value = ""),
);
async function revealPassword() {
  const { host, port, user } = props.host;
  await withBusy(revealing, async () => {
    shown.value = await invoke<string>("host_password_reveal", {
      host,
      port,
      user,
      master: master.value,
    });
    revealOpen.value = false;
  });
  master.value = "";
}

const keyName = computed(() => keys.value.find((k) => k.id === props.host.keyId)?.name);
/** ~/.ssh/known_hosts line under host's name; none if names hashed. */
const hostKeyLine = computed(() => {
  const names = [props.host.host, `[${props.host.host}]:${props.host.port}`];
  return knownHosts.value.find((k) => k.hosts.split(",").some((n) => names.includes(n)));
});

const rules = computed(() =>
  METRICS.map((m) => ({
    text: describeRule(m.id, ruleFor(props.host.id, m.id)),
    firing: alerts.value.some((a) => a.metric === m.id),
  })),
);
const custom = computed(
  () => Object.keys(settings.monitoring.overrides[props.host.id!] ?? {}).length > 0,
);

const { available } = useServices();
const { results, busy: checking } = useServiceHealth(() => props.host.id);
const checkNow = () => checkHost(props.host);
/** Rows: own services always, built-ins once seen installed. The rest wait under Install. */
const installed = (s: Service) => {
  const r = results.value[s.id!];
  return !!r && r.health !== "missing" && r.health !== "unknown";
};
const services = computed(() => available.value.filter((s) => !isBuiltIn(s) || installed(s)));
// Checked ones only: nothing is offered that detect is about to find installed.
const installMenu = computed(() => [
  available.value
    .filter(
      (s) =>
        isBuiltIn(s) && results.value[s.id!] && !installed(s) && s.functions.install !== undefined,
    )
    .map((s) => ({
      label: s.name,
      description: s.description,
      icon: "i-ph-download-simple-duotone",
      onSelect: () => runAction(props.host, s, "install"),
    })),
]);
// Detect on open: whatever was never checked here, so buttons show without Check now. Keyed
// on ids: a saved copy replacing a built-in of the same name is a new id, same length.
watch(
  () => [props.host.id, available.value.map((s) => s.id).join()],
  () => {
    const unchecked = (s: Service) => !results.value[s.id!];
    if (available.value.some(unchecked)) void checkHost(props.host, unchecked);
  },
  { immediate: true },
);
/** Row buttons, from its last check and the functions the service has. Each runs in a new
 *  terminal tab. */
function actionsFor(s: Service) {
  const r = results.value[s.id!];
  const has = (f: ServiceFunction) => s.functions[f] !== undefined;
  const act = (fn: ServiceFunction, label: string) => ({
    label,
    run: () => runAction(props.host, s, fn),
  });
  if (!r || r.health === "unknown") return [];
  if (r.health === "missing") return has("install") ? [act("install", "Install")] : [];
  return [
    ...((r.health === "warn" || r.health === "crit") && has("fix")
      ? [act("fix", s.fixLabel || "Fix")]
      : []),
    ...(r.update && has("upgrade") ? [act("upgrade", "Upgrade")] : []),
    ...(has("logs") ? [act("logs", "Logs")] : []),
  ];
}
/** Upgrade here too when no update was detected (a runtime's installer always fetches the
 *  newest), and Uninstall. */
const moreFor = (s: Service) => {
  const r = results.value[s.id!];
  if (!r || r.health === "missing" || r.health === "unknown") return [];
  const items = [];
  if (s.functions.upgrade !== undefined && !r.update)
    items.push({
      label: "Upgrade",
      icon: "i-ph-arrow-circle-up-duotone",
      onSelect: () => runAction(props.host, s, "upgrade"),
    });
  if (s.functions.uninstall !== undefined)
    items.push({
      label: "Uninstall",
      icon: "i-ph-trash-duotone",
      color: "error" as const,
      onSelect: () => runAction(props.host, s, "uninstall"),
    });
  return items.length ? [items] : [];
};
const view = useView();
const checkedAt = computed(() => Math.max(0, ...Object.values(results.value).map((r) => r.at)));
const HEALTH_LOOK: Record<Health | "none", { icon: string; tone: string }> = {
  ok: { icon: "i-ph-check-circle-duotone", tone: "text-success" },
  warn: { icon: "i-ph-warning-circle-duotone", tone: "text-warning" },
  crit: { icon: "i-ph-x-circle-duotone", tone: "text-error" },
  unknown: { icon: "i-ph-question-duotone", tone: "text-muted" },
  missing: { icon: "i-ph-minus-circle-duotone", tone: "text-dimmed" },
  none: { icon: "i-ph-circle-dashed", tone: "text-dimmed" },
};

const activity = ref<Activity[]>([]);
async function loadActivity() {
  try {
    activity.value = (
      await invoke<Activity[]>("activity_list", { hostKey: hostKey(props.host) })
    ).reverse();
  } catch {
    activity.value = [];
  }
}
watch([() => hostKey(props.host), activityVersion], loadActivity, { immediate: true });

function when(at: number) {
  const ms = at * 1000 - Date.now();
  if (ms > -60_000) return "just now";
  if (ms > -7 * 86_400_000) return fromNow(ms);
  return new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}
</script>

<template>
  <main class="pane max-w-[860px]">
    <header class="flex flex-wrap items-center gap-3.5">
      <HostLogo :os="host.os" />
      <!-- basis: buttons wrap below before name squeezes -->
      <div class="min-w-0 grow basis-56">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="t-heading truncate">{{ hostName(host) }}</h2>
          <HostChip v-if="host.group" :label="host.group" :group="host.group" />
          <UBadge :label="status.label" size="sm" class="font-mono" :class="status.tone" />
        </div>
        <p class="truncate font-mono text-xs text-muted">{{ hostLabel(host) }}</p>
      </div>
      <div class="flex items-center gap-1.5">
        <UButton icon="i-ph-terminal-window-duotone" label="Connect" @click="emit('connect')" />
        <UDropdownMenu :items="menu" :content="{ align: 'end' }">
          <UButton
            icon="i-ph-dots-three"
            color="neutral"
            variant="outline"
            :aria-label="`More for ${hostName(host)}`"
          />
        </UDropdownMenu>
      </div>
    </header>

    <section class="flex flex-col gap-3 card px-4 py-3.5" aria-label="Monitoring">
      <!-- charts carry own label -->
      <span v-if="monitoring !== 'charts'" class="t-label">Monitoring</span>
      <MonitorCharts v-if="monitoring === 'charts'" :target="host" wide />
      <div v-else-if="monitoring === 'off'" class="flex flex-wrap items-center gap-3.5">
        <div class="flex min-w-60 flex-1 flex-col gap-1 text-sm">
          <span class="font-medium">Monitoring is off for this host</span>
          <span class="text-muted">
            Watching keeps a background login open and samples every second. It shows in the
            server's auth logs.
          </span>
        </div>
        <UButton
          label="Watch this host"
          color="neutral"
          variant="outline"
          @click="setWatched(host, true)"
        />
      </div>
      <div v-else class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Live only while a terminal is open</span>
        <span class="text-muted">
          This host signs in with a password, so Lynxterm doesn't sample it in the background.
          Connect to see its usage here.
        </span>
      </div>
    </section>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
      <section class="flex flex-col gap-3 card px-4 py-3.5" aria-label="Details">
        <span class="t-label">Details</span>
        <dl class="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2 text-sm">
          <dt class="text-muted">Address</dt>
          <dd class="truncate font-mono text-xs">{{ hostLabel(host) }}</dd>
          <dt class="text-muted">Sign in with</dt>
          <dd v-if="keyName">Key {{ keyName }}</dd>
          <!-- field gets own full-width row, dd column too narrow -->
          <template v-else-if="host.savedPassword">
            <dd>Saved password</dd>
            <dd class="col-span-2">
              <UInput
                :model-value="shown || 'password'"
                :type="shown ? 'text' : 'password'"
                readonly
                size="sm"
                aria-label="Saved password"
                class="w-full"
                :ui="{ base: shown ? 'pe-21 font-mono' : 'pe-15 font-mono', trailing: 'pe-1' }"
              >
                <template #trailing>
                  <UButton
                    v-if="shown"
                    icon="i-ph-copy-duotone"
                    size="xs"
                    color="neutral"
                    variant="link"
                    aria-label="Copy password"
                    @click="copyText(shown, 'Password copied')"
                  />
                  <UButton
                    :icon="shown ? 'i-ph-eye-slash-duotone' : 'i-ph-eye-duotone'"
                    size="xs"
                    color="neutral"
                    variant="link"
                    :aria-label="shown ? 'Hide password' : 'Show password'"
                    @click="shown ? (shown = '') : ((revealOpen = true), (master = ''))"
                  />
                  <UButton
                    icon="i-ph-trash-duotone"
                    size="xs"
                    color="neutral"
                    variant="link"
                    aria-label="Forget password"
                    @click="forgetPassword"
                  />
                </template>
              </UInput>
            </dd>
          </template>
          <dd v-else>Password, asked each time</dd>
          <template v-if="host.os">
            <dt class="text-muted">System</dt>
            <dd class="capitalize">{{ host.os }}</dd>
          </template>
          <dt class="text-muted">Tags</dt>
          <dd class="flex flex-wrap gap-1.5">
            <span
              v-for="t in host.tags ?? []"
              :key="t"
              class="rounded bg-accented px-1.5 py-px font-mono text-[11px] text-toned"
            >
              {{ t }}
            </span>
            <span v-if="!host.tags?.length" class="text-muted">None</span>
          </dd>
          <template v-if="hostKeyLine">
            <dt class="text-muted">Host key</dt>
            <dd class="truncate font-mono text-xs text-toned">{{ hostKeyLine.fingerprint }}</dd>
          </template>
        </dl>
      </section>

      <section class="flex flex-col gap-3 card px-4 py-3.5" aria-label="Alert rules">
        <div class="flex items-center gap-2">
          <span class="t-label">Alerts</span>
          <span class="text-xs text-muted">{{
            custom ? "custom for this host" : "follows the defaults"
          }}</span>
          <UButton
            label="Edit rules"
            size="xs"
            color="neutral"
            variant="ghost"
            class="ml-auto"
            @click="openSettings('monitoring')"
          />
        </div>
        <div class="flex flex-wrap gap-1.5">
          <UBadge
            v-for="r in rules"
            :key="r.text"
            :label="r.text"
            size="sm"
            class="font-mono"
            :class="r.firing && 'text-error ring-error/40'"
          />
        </div>
        <span class="text-xs text-muted">
          {{
            alerts.length
              ? "Firing now. Snooze it from the ••• menu next to Connect."
              : "Change them for this host in Settings, Monitoring."
          }}
        </span>
      </section>
    </div>

    <section class="flex flex-col gap-3 card px-4 py-3.5" aria-label="Services">
      <div class="flex items-center gap-2">
        <span class="t-label">Services</span>
        <span v-if="checkedAt" class="text-xs text-muted"
          >checked {{ when(checkedAt / 1000) }}</span
        >
        <UButton
          label="Check now"
          icon="i-ph-arrows-clockwise"
          size="xs"
          color="neutral"
          variant="ghost"
          class="ml-auto"
          :loading="checking"
          @click="checkNow"
        />
        <UDropdownMenu
          v-if="installMenu[0]!.length"
          :items="installMenu"
          :content="{ align: 'end' }"
        >
          <UButton
            label="Install"
            icon="i-ph-plus"
            trailing-icon="i-ph-caret-down"
            size="xs"
            color="neutral"
            variant="outline"
          />
        </UDropdownMenu>
      </div>
      <ul v-if="services.length" class="flex flex-col gap-2 text-sm">
        <li
          v-for="s in services"
          :key="s.id"
          class="flex items-center gap-3"
          :class="results[s.id!]?.health === 'missing' && 'text-dimmed'"
        >
          <UIcon
            :name="HEALTH_LOOK[results[s.id!]?.health ?? 'none'].icon"
            class="size-4 shrink-0"
            :class="HEALTH_LOOK[results[s.id!]?.health ?? 'none'].tone"
          />
          <span class="w-36 shrink-0 truncate font-medium">{{ s.name }}</span>
          <span class="min-w-0 flex-1 truncate" :title="results[s.id!]?.summary">{{
            results[s.id!]?.summary ?? "Not checked yet"
          }}</span>
          <UBadge
            v-if="results[s.id!]?.update"
            :label="`update ${results[s.id!]!.update}`"
            size="sm"
            class="max-w-40 truncate font-mono"
          />
          <span
            v-else-if="results[s.id!]?.version"
            class="max-w-48 truncate t-sub"
            :title="results[s.id!]!.version"
            >{{ results[s.id!]!.version }}</span
          >
          <UButton
            v-for="a in actionsFor(s)"
            :key="a.label"
            :label="a.label"
            size="xs"
            color="neutral"
            variant="outline"
            @click="a.run"
          />
          <UDropdownMenu v-if="moreFor(s).length" :items="moreFor(s)" :content="{ align: 'end' }">
            <UButton
              icon="i-ph-dots-three"
              size="xs"
              square
              color="neutral"
              variant="ghost"
              :aria-label="`More for ${s.name}`"
            />
          </UDropdownMenu>
        </li>
      </ul>
      <span class="text-xs text-muted">
        <template v-if="services.length">
          Services with Check on connect run when a terminal connects here.
        </template>
        <template v-else>
          Nothing installed here yet. Install lists what LynxTerm can set up; your own go in
          <ULink class="text-primary" @click="view = 'services'">Services</ULink>.
        </template>
      </span>
    </section>

    <section class="flex flex-col gap-3 card px-4 py-3.5" aria-label="Activity">
      <span class="t-label">Activity</span>
      <ol class="flex flex-col gap-2 text-sm">
        <li v-for="a in activity" :key="`${a.at}-${a.title}`" class="flex gap-3.5">
          <span class="w-24 shrink-0 text-muted" :title="new Date(a.at * 1000).toLocaleString()">{{
            when(a.at)
          }}</span>
          <span class="min-w-0 flex-1">
            <span :class="a.ok === false && 'text-error'">{{ a.title }}</span>
            <span v-if="a.detail" class="block truncate t-sub" :title="a.detail">{{
              a.detail
            }}</span>
          </span>
        </li>
        <li v-if="!activity.length" class="text-muted">
          Nothing yet. Snippets you run, keys you install, files you move and setup changes on this
          server show up here.
        </li>
      </ol>
    </section>

    <UModal v-model:open="revealOpen" :title="`Show password for ${hostName(host)}`">
      <template #body>
        <form id="reveal-form" class="flex flex-col gap-3" @submit.prevent="revealPassword">
          <p class="text-sm text-muted">
            Enter your master password to see the saved password for
            <span class="font-mono">{{ hostLabel(host) }}</span
            >.
          </p>
          <UFormField label="Master password">
            <UInput v-model="master" type="password" required autofocus class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <UButton type="submit" form="reveal-form" label="Show" :loading="revealing" />
      </template>
    </UModal>
  </main>
</template>
