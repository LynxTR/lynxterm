<script setup lang="ts">
import type { SshTarget } from "~/components/SshTerminal.vue";

const props = defineProps<{ target?: SshTarget }>();
const emit = defineEmits<{ close: [] }>();
const { hosts } = useHosts();
const { forwards, running, save, start, stop } = useForwards();
const toast = useToast();

const host = computed(
  () => props.target && hosts.value.find((h) => hostKey(h) === hostKey(props.target!)),
);
const mine = computed(() => forwards.value.filter((f) => f.hostId === host.value?.id));
const isRunning = (f: Forward) => running.value.includes(f.id!);

const busy = ref<string | null>(null);
async function toggle(f: Forward) {
  busy.value = f.id!;
  try {
    await (isRunning(f) ? stop(f.id!) : start(f.id!));
  } catch (e) {
    toast.add({ title: String(e), color: "error" });
  } finally {
    busy.value = null;
  }
}

const draft = reactive({ name: "", localPort: "", remoteHost: "127.0.0.1", remotePort: "" });
async function add(andStart: boolean) {
  if (!host.value?.id) return;
  const forward: Forward = {
    name: draft.name.trim() || `${draft.remoteHost}:${draft.remotePort}`,
    hostId: host.value.id,
    localPort: Number(draft.localPort),
    remoteHost: draft.remoteHost.trim(),
    remotePort: Number(draft.remotePort),
  };
  try {
    const id = await save(forward);
    if (andStart) await start(id);
    Object.assign(draft, { name: "", localPort: "", remotePort: "" });
  } catch (e) {
    toast.add({ title: String(e), color: "error" });
  }
}
</script>

<template>
  <ToolPanel title="Port forwarding" :chip="target && hostName(target)" @close="emit('close')">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="!host" class="p-4 text-sm text-muted">
        Save this host first; forwards belong to saved hosts.
      </p>
      <template v-else>
        <ul>
          <li
            v-for="f in mine"
            :key="f.id"
            class="flex items-center gap-3 border-b border-muted px-3.5 py-2.5"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ f.name }}</span>
              <span class="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted">
                <UBadge :label="`localhost:${f.localPort}`" size="sm" />
                <span>-></span>
                <UBadge :label="`${f.remoteHost}:${f.remotePort}`" size="sm" />
              </span>
            </span>
            <UBadge
              :label="isRunning(f) ? 'running' : 'stopped'"
              :variant="isRunning(f) ? 'soft' : 'outline'"
              size="sm"
            />
            <UButton
              :label="isRunning(f) ? 'Stop' : 'Start'"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="busy === f.id"
              :disabled="!host.keyId && !isRunning(f)"
              :title="
                !host.keyId ? 'Password hosts start forwards from the Port forwarding page' : ''
              "
              @click="toggle(f)"
            />
          </li>
        </ul>
        <form
          class="m-3.5 flex flex-col gap-2.5 rounded-lg border border-dashed border-accented p-3.5"
          @submit.prevent="add(true)"
        >
          <span class="t-label">New forward</span>
          <UFormField label="Name" size="sm">
            <UInput v-model="draft.name" placeholder="redis" size="sm" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-2 gap-2">
            <UFormField label="Local port" size="sm">
              <UInput
                v-model="draft.localPort"
                type="number"
                required
                size="sm"
                class="w-full font-mono"
              />
            </UFormField>
            <UFormField label="Remote port" size="sm">
              <UInput
                v-model="draft.remotePort"
                type="number"
                required
                size="sm"
                class="w-full font-mono"
              />
            </UFormField>
          </div>
          <UFormField label="Remote host" size="sm">
            <UInput v-model="draft.remoteHost" required size="sm" class="w-full font-mono" />
          </UFormField>
          <div class="flex gap-2">
            <UButton
              type="submit"
              label="Add and start"
              size="sm"
              class="flex-1"
              :disabled="!host.keyId"
            />
            <UButton label="Add" size="sm" color="neutral" variant="outline" @click="add(false)" />
          </div>
        </form>
      </template>
    </div>
    <p class="border-t border-default px-3.5 py-2.5 text-xs text-dimmed">
      Forwards run through their own connection to the host and keep going when this tab closes.
    </p>
  </ToolPanel>
</template>
