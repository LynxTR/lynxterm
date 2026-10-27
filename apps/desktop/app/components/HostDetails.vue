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

const logo = computed(() => osLogo(props.host.os));
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
      <span
        class="flex size-11 shrink-0 items-center justify-center rounded-[10px]"
        :class="logo ? '' : 'bg-elevated text-muted'"
        :style="logo && { backgroundColor: logo.bg, color: logo.dark ? '#1a1200' : '#fff' }"
        role="img"
        :aria-label="host.os || 'Unknown system'"
      >
        <Icon v-if="logo" :name="logo.icon" :customize="false" class="size-6" />
        <UIcon v-else name="i-ph-hard-drives-duotone" class="size-6" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="truncate text-xl font-semibold">{{ hostName(host) }}</h2>
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
          This host signs in with a password, which Lynxterm never stores, so it can't sample in the
          background. Connect to see its usage here.
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
          <dd>{{ keyName ? `Key ${keyName}` : "Password, asked each time" }}</dd>
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

    <section class="flex flex-col gap-3 card px-4 py-3.5" aria-label="Activity">
      <span class="t-label">Activity</span>
      <ol class="flex flex-col gap-2 text-sm">
        <li v-for="a in activity" :key="`${a.at}-${a.title}`" class="flex gap-3.5">
          <span class="w-24 shrink-0 text-muted" :title="new Date(a.at * 1000).toLocaleString()">{{
            when(a.at)
          }}</span>
          <span class="min-w-0 flex-1">
            <span :class="a.ok === false && 'text-error'">{{ a.title }}</span>
            <span
              v-if="a.detail"
              class="block truncate font-mono text-[11px] text-muted"
              :title="a.detail"
              >{{ a.detail }}</span
            >
          </span>
        </li>
        <li v-if="!activity.length" class="text-muted">
          Nothing yet. Snippets you run, keys you install, files you move and setup changes on this
          server show up here.
        </li>
      </ol>
    </section>
  </main>
</template>
