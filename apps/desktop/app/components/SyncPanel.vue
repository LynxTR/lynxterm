<script setup lang="ts">
const sync = useSync();
const { url, host, error, signedOut, busy, state, ago, newDevices } = sync;

const badge = computed(() =>
  state.value === "error"
    ? { label: "Failing", icon: "i-ph-warning-circle-duotone", color: "error" as const }
    : signedOut.value
      ? { label: "Signed out", icon: "i-ph-sign-out-duotone", color: "warning" as const }
      : { label: "Connected", icon: "i-ph-check", color: "success" as const },
);

const password = ref("");
async function signIn() {
  await sync.signIn(password.value);
  if (!signedOut.value) password.value = "";
}

watch([url, busy], ([u, b]) => u && !b && sync.refreshStatus(), { immediate: true });

const checks = computed(() => {
  const on = SYNC_SECTIONS.filter((s) => !sync.isOff(s)).map(sync.every);
  if (!on.length) return "nothing syncs";
  const m = Math.min(...on);
  const every = SYNC_EVERY.find((o) => o.value === m)?.label.toLowerCase() ?? `every ${m} minutes`;
  return `checks ${every} while in use`;
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="t-title">Sync</h2>
      <UBadge v-if="url" v-bind="badge" />
      <UButton
        v-if="url && !signedOut"
        icon="i-ph-arrows-clockwise"
        label="Sync now"
        variant="outline"
        class="ml-auto"
        :loading="busy"
        @click="sync.syncNow"
      />
    </div>

    <form v-if="url && signedOut" class="box gap-3 p-4" @submit.prevent="signIn">
      <div class="flex flex-col gap-1.5">
        <h3 class="t-section">Sign in again</h3>
        <p class="text-sm text-muted">
          Your master password was changed on another device, which signed this one out of your
          Worker. Enter the new password to keep syncing. It unlocks this device from now on too.
        </p>
      </div>
      <UFieldGroup class="w-full max-w-md">
        <UInput
          v-model="password"
          type="password"
          required
          placeholder="New master password"
          aria-label="New master password"
          class="flex-1"
        />
        <UButton color="primary" type="submit" label="Sign in" :loading="busy" />
      </UFieldGroup>
      <p v-if="error" class="text-sm text-error">{{ error }}</p>
    </form>

    <div
      v-if="url"
      class="grid max-w-3xl grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-4 card p-4"
    >
      <div class="flex min-w-0 flex-col gap-1">
        <span class="t-label">Your worker</span>
        <CopyText :text="url" what="Worker URL" class="truncate font-mono text-[13px]">{{
          host
        }}</CopyText>
      </div>
      <div class="flex flex-col gap-1">
        <span class="t-label">Last sync</span>
        <span class="text-[13px]">{{ ago }}</span>
        <span class="text-xs text-muted">{{ checks }}</span>
      </div>
      <div v-if="newDevices !== null" class="flex flex-col gap-1">
        <span class="t-label">New devices</span>
        <span class="text-[13px]">{{ newDevices ? "Allowed" : "Turned off" }}</span>
        <span class="text-xs text-muted">
          {{
            newDevices
              ? "Anyone with its address can try to sign in."
              : "Only devices signed in now."
          }}
          <button
            type="button"
            class="text-primary underline-offset-2 hover:underline"
            @click="sync.newDevicesOpen.value = true"
          >
            {{ newDevices ? "Turn it off" : "How to add one" }}
          </button>
        </span>
      </div>
    </div>

    <div v-if="url" class="box">
      <div class="flex flex-col gap-1.5 border-b border-default p-4">
        <h3 class="t-section">What syncs, and how often</h3>
        <p class="text-sm text-muted">
          A check is one request and brings your other devices' changes for every section at once.
          Each section sends this device's changes when its turn comes. Idle or in the background,
          Lynxterm only goes out when it has something to send. Off keeps a section on this device;
          what is already on your Worker stays there.
        </p>
      </div>
      <SyncSections show-next class="px-4 py-1" />
    </div>

    <div v-else class="box gap-4 p-4">
      <p class="text-sm text-muted">
        Keep your vault in sync across devices through a Cloudflare Worker on your own account. It
        fits in the free plan and only ever stores encrypted blobs.
      </p>
      <SyncConnect />
    </div>

    <UAlert
      v-if="url && error && !signedOut"
      color="error"
      variant="subtle"
      icon="i-ph-warning-circle-duotone"
      :title="error"
      class="max-w-3xl"
    />
  </div>
</template>
