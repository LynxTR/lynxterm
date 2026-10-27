<script setup lang="ts">
const { newDevices, newDevicesOpen: open, devices, host, refreshStatus } = useSync();

// "lynxterm-vault" from lynxterm-vault.you.workers.dev; "" on custom domain.
const worker = computed(() =>
  host.value.endsWith(".workers.dev") ? host.value.split(".")[0] : "",
);
const CLOUDFLARE = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

watch(open, (o) => o && refreshStatus());
</script>

<template>
  <UModal
    v-model:open="open"
    :title="newDevices === false ? 'New devices are off' : 'New devices can sign in'"
  >
    <template #body>
      <div v-if="newDevices === false" class="flex flex-col gap-3 text-sm text-toned">
        <p>
          Only the devices signed in now can reach your Worker. Nobody else can try your master
          password on it.
        </p>
        <p class="text-muted">
          To add a device later, delete <span class="font-mono">NEW_DEVICES</span> on Cloudflare,
          join, then add it back.
        </p>
      </div>
      <div v-else class="flex flex-col gap-4 text-sm text-toned">
        <p>
          Anyone who finds your Worker's address can try master passwords on it. Devices already
          signed in don't need this, so once all of yours are, it's safer to turn it off.
          <span v-if="devices" class="text-muted">
            So far, {{ devices }} {{ devices === 1 ? "device has" : "devices have" }} signed in.
          </span>
        </p>
        <ol class="flex list-decimal flex-col gap-1.5 pl-5">
          <li>
            On Cloudflare, open Workers & Pages, then
            <span class="font-mono text-highlighted">{{ worker || "your Worker" }}</span
            >, Settings, Variables and Secrets.
          </li>
          <li>
            Add a variable named <span class="font-mono text-highlighted">NEW_DEVICES</span> with
            the value <span class="font-mono text-highlighted">off</span>, then deploy.
          </li>
          <li>Come back to Lynxterm. The warning goes away once your Worker has it.</li>
        </ol>
        <p class="text-muted">
          To add a device later, delete the variable, join, then add it back.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton v-if="newDevices === false" label="Done" @click="open = false" />
        <template v-else>
          <UButton label="Not now" color="neutral" variant="ghost" @click="open = false" />
          <UButton
            label="Open Cloudflare"
            trailing-icon="i-ph-arrow-square-out"
            @click="openExternal(CLOUDFLARE)"
          />
        </template>
      </div>
    </template>
  </UModal>
</template>
