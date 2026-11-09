<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { useResizeObserver, useScroll } from "@vueuse/core";

const status = ref<"none" | "locked" | "unlocked">();
const { firstRun } = useOnboarding();
onMounted(
  async () => (status.value = await invoke<"none" | "locked" | "unlocked">("vault_status")),
);

const { hosts } = useHosts();
const { keys } = useKeys();
const { snippets } = useSnippets();
const { services } = useServices();
const { forwards } = useForwards();
const { knownHosts, refresh: refreshKnownHosts } = useKnownHosts();
const sync = useSync();
const { state: syncState, host: syncHost, ago, newDevices, newDevicesOpen } = sync;

// Alerts watch every host's live readings; nothing streams until vault opens.
startAlerts();
startServiceChecks();
startUpdateChecks();

watch(status, async (s) => {
  if (s !== "unlocked") return sync.stop();
  await Promise.all([sync.reload(), refreshKnownHosts()]);
  sync.start();
});

const { tabs, current, closeTab, closeAll } = useSessions();
const tabDot = (t: Tab) =>
  t.panes.some((p) => p.state === "open")
    ? "bg-success"
    : t.panes.some((p) => p.state === "connecting")
      ? "bg-primary"
      : "bg-[var(--ui-text-dimmed)]";
// Terminals stay laid out under Home: focused one keeps taking keys.
watch(current, (c) => c === null && (document.activeElement as HTMLElement | null)?.blur());

function openHome(v?: View) {
  current.value = null;
  if (v) view.value = v;
}

async function lock() {
  await invoke("vault_lock");
  closeAll();
  status.value = "locked"; // unmounts everything, closing every session
}

const view = useView();
const nav = computed(
  () =>
    [
      { id: "hosts", label: "Hosts", icon: "i-ph-hard-drives-duotone", count: hosts.value.length },
      { id: "keychain", label: "Keychain", icon: "i-ph-key-duotone", count: keys.value.length },
      {
        id: "snippets",
        label: "Snippets",
        icon: "i-ph-code-duotone",
        count: snippets.value.length,
      },
      {
        id: "services",
        label: "Services",
        icon: "i-ph-cube-duotone",
        count: services.value.length,
      },
      {
        id: "forwards",
        label: "Port forwarding",
        icon: "i-ph-arrows-left-right",
        count: forwards.value.length,
      },
      {
        id: "known",
        label: "Known hosts",
        icon: "i-ph-shield-check-duotone",
        count: knownHosts.value.length,
      },
      { id: "settings", label: "Settings", icon: "i-ph-gear-duotone" },
    ] as const,
);
// Trusting a host in a terminal adds to known_hosts: refresh on open.
watch(view, (v) => v === "known" && refreshKnownHosts());

const navItems = computed(() =>
  nav.value.map((i) => ({
    label: i.label,
    icon: i.icon,
    badge: "count" in i ? i.count : undefined,
    active: view.value === i.id,
    class: view.value === i.id ? "nav-active" : undefined,
    onSelect: () => (view.value = i.id),
  })),
);

// Ctrl+K palette. Inside terminal Ctrl+K is the shell's, so there Ctrl+Shift+K.
const paletteOpen = ref(false);
const term = ref("");
const { activePane, connect, runSnippet } = useSessions();
// Typed user@host connects without saving.
const quickTarget = computed(() => parseTarget(term.value));
// Open tabs: palette's "Open sessions" and tab strip's All tabs menu.
const tabItems = computed(() =>
  tabs.value.map((t) => ({
    label: hostName(t.panes[0]!.target),
    suffix: hostLabel(t.panes[0]!.target),
    icon: "i-ph-terminal-duotone",
    onSelect: () => (current.value = t.key),
  })),
);
const paletteGroups = computed(() => [
  {
    id: "ssh",
    label: "SSH",
    ignoreFilter: true,
    items: quickTarget.value
      ? [
          {
            label: `Connect to ${hostLabel(quickTarget.value)}`,
            icon: "i-ph-terminal-window-duotone",
            onSelect: () => connect(quickTarget.value!),
          },
        ]
      : [],
  },
  {
    id: "hosts",
    label: "Hosts",
    items: hosts.value.map((h) => ({
      label: hostName(h),
      suffix: hostLabel(h),
      icon: "i-ph-hard-drives-duotone",
      onSelect: () => connect(h),
    })),
  },
  { id: "sessions", label: "Open sessions", items: tabItems.value },
  {
    id: "snippets",
    label: "Run snippet",
    items:
      activePane.value?.session === undefined
        ? []
        : snippets.value.map((sn) => ({
            label: sn.name,
            suffix: sn.command,
            icon: "i-ph-code-duotone",
            onSelect: () => runSnippet(sn),
          })),
  },
  {
    id: "go",
    label: "Go to",
    items: [
      ...nav.value.map((i) => ({ label: i.label, icon: i.icon, onSelect: () => openHome(i.id) })),
      {
        label: "Lock vault",
        icon: "i-ph-lock-duotone",
        kbds: ["meta", "shift", "l"],
        onSelect: lock,
      },
    ],
  },
]);

// Fade strip's right edge only while more tabs hide past it.
const tabScroller = useTemplateRef<HTMLElement>("tabScroller");
const { arrivedState, measure } = useScroll(tabScroller);
useResizeObserver(tabScroller, measure);
watch(
  () => tabs.value.length,
  () => nextTick(measure),
);

const tabStrip = useTemplateRef<HTMLElement>("tabStrip");
const { box: tabBar, measure: measureTabBar } = useIndicator(tabStrip, current, "[data-active]");
const tabBarColor = computed(() => {
  if (current.value === null) return "var(--ui-primary)";
  const tab = tabs.value.find((t) => t.key === current.value);
  return groupColor(tab?.panes[0]?.target.group) || "var(--ui-border-accented)";
});
function sizeTab(el: Element, open: boolean, done: () => void) {
  const e = el as HTMLElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
  const style = getComputedStyle(e);
  const full = {
    width: `${e.offsetWidth}px`,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    opacity: 1,
  };
  const none = { width: "0px", paddingLeft: "0px", paddingRight: "0px", opacity: 0 };
  e.style.overflow = "hidden";
  const animation = e.animate(open ? [none, full] : [full, none], {
    duration: open ? 200 : 150,
    easing: open ? "cubic-bezier(0.2, 0.8, 0.2, 1)" : "ease-in",
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    e.style.overflow = "";
    done();
    measureTabBar();
  };
  animation.onfinish = finish;
  setTimeout(finish, 400); // no paint, no finish event: closed tab must still go
}
const navBox = useTemplateRef<HTMLElement>("navBox");
const { box: navMark } = useIndicator(navBox, view, ".nav-active");

defineShortcuts({
  meta_k: {
    usingInput: true,
    handler: () => document.activeElement?.closest(".xterm") || (paletteOpen.value = true),
  },
  meta_t: { usingInput: true, handler: () => (paletteOpen.value = true) },
  meta_0: { usingInput: true, handler: () => openHome() },
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
      `meta_${n}`,
      {
        usingInput: true,
        handler: () => (current.value = tabs.value[n - 1]?.key ?? current.value),
      },
    ]),
  ),
  meta_w: { usingInput: true, handler: () => current.value !== null && closeTab(current.value) },
  // Shift: Ctrl+L alone is shell clear-screen.
  meta_shift_l: { handler: lock, usingInput: true },
});

const syncDot = computed(
  () =>
    ({
      off: { text: "Sync is off", dot: "" },
      busy: { text: "Syncing…", dot: "bg-primary animate-pulse" },
      error: { text: "Sync failed", dot: "bg-error" },
      signedOut: { text: "Signed out of sync", dot: "bg-warning" },
      ok: {
        text: ago.value === "not yet" ? "Connected" : `Synced ${ago.value}`,
        dot: "bg-success",
      },
    })[syncState.value],
);
</script>

<template>
  <UApp>
    <Transition name="screen" mode="out-in" appear>
      <VaultScreen
        v-if="status === 'none' || status === 'locked'"
        :status="status"
        @unlocked="status = 'unlocked'"
      />
      <SetupScreen v-else-if="status === 'unlocked' && firstRun" @done="openHome('hosts')" />

      <div
        v-else-if="status === 'unlocked'"
        class="flex h-screen flex-col overflow-hidden bg-default text-sm"
      >
        <header
          data-tauri-drag-region
          class="flex h-11 shrink-0 items-stretch border-b border-default bg-sunken"
          :class="isMac && 'pl-20'"
        >
          <!-- macOS: traffic lights left (centered on tabs, tauri.macos.conf.json), logo right -->
          <button
            class="relative flex shrink-0 items-center px-3.5 pt-1.5 transition-colors hover:bg-elevated"
            :class="isMac && 'order-last'"
            :title="syncHost ? `${syncDot.text}, ${syncHost}` : syncDot.text"
            :aria-label="`${syncDot.text}. Open sync settings`"
            @click="
              openSettings('sync');
              current = null;
            "
          >
            <img src="/logo.svg" alt="" class="size-5" />
            <span
              v-if="syncDot.dot"
              class="absolute right-2 bottom-2 size-[7px] rounded-full ring-2 ring-sunken"
              :class="syncDot.dot"
            />
          </button>

          <!-- Tauri drags only from marked elements -->
          <div
            ref="tabStrip"
            data-tauri-drag-region
            class="relative flex min-w-0 flex-1 items-stretch gap-0.5 pt-1.5"
          >
            <span
              v-show="tabBar.shown"
              aria-hidden="true"
              class="pointer-events-none absolute z-10 h-0.5 rounded-full transition-[left,width,top,background-color] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
              :style="{
                left: `${tabBar.left + 10}px`,
                width: `${Math.max(tabBar.width - 20, 0)}px`,
                top: `${tabBar.top - 1}px`,
                background: tabBarColor,
              }"
            />
            <button
              role="tab"
              :aria-selected="current === null"
              :data-active="current === null || undefined"
              class="tab -mb-px px-4"
              @click="openHome()"
            >
              <UIcon name="i-ph-house-duotone" class="size-4" />
              Home
            </button>
            <!-- scroll clips edges: list 1px past strip, tabs keep border, cover bottom line -->
            <div
              data-tauri-drag-region
              role="tablist"
              aria-label="Sessions"
              ref="tabScroller"
              class="-my-px flex min-w-0 items-stretch gap-0.5 overflow-x-auto px-px pt-px [scrollbar-width:none]"
              :class="!arrivedState.right && 'mask-r-from-[calc(100%-28px)]'"
              @scroll="measureTabBar"
            >
              <TransitionGroup
                :css="false"
                @enter="(el, done) => sizeTab(el, true, done)"
                @leave="(el, done) => sizeTab(el, false, done)"
              >
                <div
                  v-for="t in tabs"
                  :key="t.key"
                  :data-active="t.key === current || undefined"
                  class="tab group pr-2 pl-4 font-mono whitespace-nowrap"
                >
                  <button
                    role="tab"
                    :aria-selected="t.key === current"
                    class="flex items-center gap-2"
                    @click="current = t.key"
                    @auxclick.middle="closeTab(t.key)"
                  >
                    <span class="size-[7px] rounded-full transition-colors" :class="tabDot(t)" />
                    {{ hostName(t.panes[0]!.target) }}
                    <UIcon
                      v-if="t.panes.length > 1"
                      name="i-ph-columns-duotone"
                      class="size-3.5 text-dimmed"
                    />
                  </button>
                  <UButton
                    icon="i-ph-x"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    aria-label="Close tab"
                    class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    :class="t.key === current && 'opacity-100'"
                    @click="closeTab(t.key)"
                  />
                </div>
              </TransitionGroup>
            </div>
            <UDropdownMenu v-if="tabs.length" :items="[tabItems]" :content="{ align: 'start' }">
              <UButton
                icon="i-ph-caret-down"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="All tabs"
                title="All tabs"
                class="self-center"
              />
            </UDropdownMenu>
            <UTooltip text="Quick connect" :kbds="['meta', 't']">
              <UButton
                icon="i-ph-plus"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="Quick connect"
                class="self-center"
                @click="paletteOpen = true"
              />
            </UTooltip>
          </div>

          <div data-tauri-drag-region class="ml-auto flex shrink-0 items-stretch">
            <WindowControls />
          </div>
        </header>

        <!-- hidden one stays laid out: no refit on return -->
        <div class="grid min-h-0 flex-1">
          <UDashboardGroup
            storage="local"
            storage-key="lynxterm"
            unit="px"
            class="lt-swap outer"
            :class="current !== null && 'off'"
          >
            <UDashboardSidebar
              id="home"
              collapsible
              resizable
              :min-size="200"
              :default-size="240"
              :max-size="300"
              :collapsed-size="64"
              :ui="{
                // drag-resize follows mouse, no transition
                root: 'flex min-h-0 border-e border-default bg-default transition-[width] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[dragging=true]:transition-none',
                header: 'h-auto px-3 pt-3 pb-2',
                body: 'gap-1 px-3 py-0',
                footer: 'px-3 py-3',
              }"
            >
              <template #header="{ collapsed }">
                <UDashboardSearchButton
                  :collapsed="collapsed"
                  label="Find or ssh…"
                  class="h-10 w-full bg-muted text-muted ring-accented"
                />
              </template>
              <template #default="{ collapsed }">
                <div ref="navBox" class="relative">
                  <span
                    v-show="navMark.shown"
                    aria-hidden="true"
                    class="pointer-events-none absolute inset-x-0 rounded-md bg-accented transition-[top,height] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
                    :style="{ top: `${navMark.top}px`, height: `${navMark.height}px` }"
                  />
                  <UNavigationMenu
                    :items="navItems"
                    :collapsed="collapsed"
                    orientation="vertical"
                    color="neutral"
                    tooltip
                    :ui="{
                      list: 'flex flex-col gap-1',
                      link: 'h-10 gap-3 px-3 font-normal text-toned transition-colors data-active:text-highlighted',
                      linkLeadingIcon: 'size-[18px]',
                      linkTrailingBadge:
                        'bg-transparent px-0 text-[11px] font-normal text-muted tabular-nums ring-0',
                    }"
                  />
                </div>
              </template>
              <template #footer="{ collapsed }">
                <div
                  class="flex w-full min-w-0 flex-col gap-2"
                  :class="collapsed && 'items-center'"
                >
                  <UTooltip v-if="newDevices" text="New devices allowed" :disabled="!collapsed">
                    <UButton
                      icon="i-ph-shield-warning-duotone"
                      :label="collapsed ? undefined : 'New devices allowed'"
                      color="warning"
                      variant="soft"
                      :square="collapsed"
                      class="h-9 font-normal"
                      :class="!collapsed && 'w-full'"
                      @click="newDevicesOpen = true"
                    />
                  </UTooltip>
                  <div
                    class="flex w-full min-w-0 gap-1"
                    :class="collapsed && 'flex-col items-center'"
                  >
                    <UTooltip text="Lock vault" :kbds="['meta', 'shift', 'l']">
                      <UButton
                        icon="i-ph-lock-duotone"
                        :label="collapsed ? undefined : 'Lock vault'"
                        color="neutral"
                        variant="ghost"
                        :square="collapsed"
                        class="h-10 min-w-0 flex-1 font-normal text-muted"
                        aria-label="Lock vault"
                        aria-keyshortcuts="Control+Shift+L Meta+Shift+L"
                        @click="lock"
                      />
                    </UTooltip>
                    <UDashboardSidebarCollapse class="h-10 shrink-0 text-muted" />
                  </div>
                </div>
              </template>
            </UDashboardSidebar>

            <HostsView v-show="view === 'hosts'" class="min-w-0 flex-1 animate-fade" />
            <KeychainView v-show="view === 'keychain'" class="min-w-0 flex-1 animate-fade" />
            <SnippetsView v-show="view === 'snippets'" class="min-w-0 flex-1 animate-fade" />
            <ServicesView v-show="view === 'services'" class="min-w-0 flex-1 animate-fade" />
            <ForwardsView v-show="view === 'forwards'" class="min-w-0 flex-1 animate-fade" />
            <KnownHostsView v-show="view === 'known'" class="min-w-0 flex-1 animate-fade" />
            <SettingsView v-show="view === 'settings'" class="min-w-0 flex-1 animate-fade" />

            <UDashboardSearch
              v-model:open="paletteOpen"
              v-model:search-term="term"
              shortcut="meta_shift_k"
              :groups="paletteGroups"
              :color-mode="false"
              placeholder="Find a host or ssh user@hostname…"
            />
            <NewDevicesDialog />
          </UDashboardGroup>
          <SessionsView class="lt-swap inner" :class="current === null && 'off'" />
        </div>
      </div>
    </Transition>
  </UApp>
</template>
