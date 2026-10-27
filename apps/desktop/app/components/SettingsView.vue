<script setup lang="ts">
const settings = useSettings();
const section = useSettingsSection();
const sections = [
  { id: "sync", label: "Sync" },
  { id: "groups", label: "Groups and tags" },
  { id: "terminal", label: "Terminal" },
  { id: "monitoring", label: "Monitoring" },
  { id: "privacy", label: "Privacy" },
  { id: "about", label: "About" },
] as const;

const { current, available, system, state } = useUpdates();
// With update available, template shows links instead.
const updateLine = computed(() => {
  if (state.value === "checking") return "Checking GitHub for a new release…";
  if (state.value === "done") return `You have the latest version for ${system.value}.`;
  if (state.value === "failed") return "Couldn't reach GitHub. Try again later.";
  return settings.checkUpdates
    ? "Lynxterm looks for a new release on GitHub when it starts."
    : "Automatic checks are off.";
});
</script>

<template>
  <div class="flex min-h-0">
    <nav
      aria-label="Settings sections"
      class="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-default px-3 py-5"
    >
      <span class="t-label px-3.5 pb-2.5">Settings</span>
      <button
        v-for="s in sections"
        :key="s.id"
        class="flex h-10 items-center rounded-md px-3.5 text-left transition-colors"
        :class="section === s.id ? 'bg-accented text-default' : 'text-toned hover:bg-elevated'"
        :aria-current="section === s.id ? 'page' : undefined"
        @click="section = s.id"
      >
        {{ s.label }}
        <span
          v-if="s.id === 'about' && available"
          class="ml-auto size-2 rounded-full bg-primary"
          aria-label="Update available"
        />
      </button>
    </nav>

    <main class="flex max-w-[920px] min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-8 pt-6 pb-8">
      <SyncPanel v-if="section === 'sync'" />
      <GroupsSettings v-else-if="section === 'groups'" />
      <TerminalSettings v-else-if="section === 'terminal'" />

      <MonitoringSettings v-else-if="section === 'monitoring'" />

      <template v-else-if="section === 'privacy'">
        <h2 class="t-title">Privacy</h2>
        <div class="flex max-w-3xl flex-col gap-4 card p-4">
          <USwitch
            v-model="settings.maskAddresses"
            label="Hide the middle of addresses"
            description="Shows 10.•.•.12 and bastion.•.net instead of full addresses in lists, tabs and status bars. Handy when sharing your screen."
          />
        </div>
        <p class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-info-duotone" class="size-[18px]" />
          Saved on this device only.
        </p>
        <EraseDevice />
      </template>

      <template v-else>
        <h2 class="t-title">About</h2>
        <div
          class="grid max-w-3xl grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-4 card p-4"
        >
          <div class="flex items-center gap-3">
            <img src="/logo.svg" alt="" class="size-10" />
            <div class="flex flex-col">
              <span class="font-semibold">Lynxterm</span>
              <span class="font-mono text-xs text-muted">{{ current || "dev" }}</span>
            </div>
          </div>
          <dl class="grid grid-cols-[90px_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt class="text-dimmed">License</dt>
            <dd>MIT, open source</dd>
            <dt class="text-dimmed">Your data</dt>
            <dd>On this device, and on your own Worker if you sync</dd>
            <template v-if="system">
              <dt class="text-dimmed">System</dt>
              <dd>{{ system }}</dd>
            </template>
          </dl>
        </div>
        <div class="flex max-w-3xl flex-col gap-3 card p-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="flex min-w-60 flex-1 flex-col gap-1">
              <span class="font-medium">Updates</span>
              <span v-if="available" class="text-sm text-muted">
                Lynxterm {{ available.version }} is out.
                <template v-if="available.download">
                  <button
                    type="button"
                    class="font-medium text-primary underline-offset-2 hover:underline"
                    :title="available.download.name"
                    @click="openExternal(available.download.url)"
                  >
                    Download the {{ available.download.kind }} for {{ system }}</button
                  >, or see
                </template>
                <template v-else>See</template>
                <button
                  type="button"
                  class="text-primary underline-offset-2 hover:underline"
                  @click="openExternal(available.url)"
                >
                  every file on the release page</button
                >.
              </span>
              <span v-else class="text-sm text-muted">{{ updateLine }}</span>
            </div>
            <UButton
              label="Check now"
              color="neutral"
              variant="outline"
              :loading="state === 'checking'"
              @click="checkForUpdate"
            />
          </div>
          <USwitch
            v-model="settings.checkUpdates"
            label="Check for updates"
            description="At start and twice a day. Each check is one request to GitHub for the latest release; GitHub sees your IP address, as with any web request."
          />
        </div>
      </template>
    </main>
  </div>
</template>
