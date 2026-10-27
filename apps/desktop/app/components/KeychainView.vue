<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";

const { keys, refresh } = useKeys();
const { hosts } = useHosts();
const sync = useSync();
const toast = useToast();

const { filter, shown } = useFilter(
  () => keys.value,
  (k) => `${k.name} ${k.fingerprint}`,
);
const selectedId = ref<string | null>(null);
const selected = computed(() => keys.value.find((k) => k.id === selectedId.value) ?? keys.value[0]);
const usedBy = (id: string) => hosts.value.filter((h) => h.keyId === id);

async function remove(id: string) {
  const k = keys.value.find((x) => x.id === id)!;
  const used = usedBy(id).length;
  const ok = await askConfirm({
    title: `Delete ${k.name}?`,
    description: used
      ? `${used} ${used === 1 ? "host signs" : "hosts sign"} in with it; they fall back to a password. The key is removed from your vault on every device.`
      : "The key is removed from your vault on every device. Servers that trust it keep its public half.",
    detail: k.fingerprint,
  });
  if (!ok) return;
  await invoke("item_delete", { id });
  await refresh();
}

const importOpen = ref(false);
const form = reactive({ name: "", source: "", passphrase: "" });
const found = ref<string[]>([]);
const importing = ref(false);

async function openImport() {
  Object.assign(form, { name: "", source: "", passphrase: "" });
  found.value = await invoke<string[]>("keys_scan");
  importOpen.value = true;
}

function pick(path: string) {
  form.source = path;
  form.name ||= path.split("/").pop()!;
}

const generateOpen = ref(false);
const newName = ref("");
async function generate() {
  await invoke("key_generate", { name: newName.value });
  await refresh();
  // Select new key: newest with that name.
  selectedId.value =
    keys.value.filter((k) => k.name === newName.value).sort((a, b) => b.createdAt - a.createdAt)[0]
      ?.id ?? null;
  generateOpen.value = false;
}
function openGenerate() {
  newName.value = "";
  generateOpen.value = true;
}

const installOpen = ref(false);
const install = reactive({ hostId: "", password: "", useForHost: true });
const installing = ref(false);
const hostItems = computed(() =>
  hosts.value.map((h) => ({ label: hostName(h), description: hostLabel(h), value: h.id! })),
);
const installHost = computed(() => hosts.value.find((h) => h.id === install.hostId));
function openInstall() {
  Object.assign(install, { hostId: hosts.value[0]?.id ?? "", password: "", useForHost: true });
  installOpen.value = true;
}
async function installKey() {
  installing.value = true;
  try {
    await invoke("key_install", { id: selected.value!.id, ...install });
    logActivity(installHost.value!, {
      kind: "key",
      title: `Installed key ${selected.value!.name}`,
      detail: "added to ~/.ssh/authorized_keys",
    });
    await useHosts().refresh();
    toast.add({
      title: `Installed on ${hostName(installHost.value!)}`,
      icon: "i-ph-check",
    });
    installOpen.value = false;
  } catch (e) {
    toast.add({ title: String(e), color: "error" });
    if (installHost.value) {
      logActivity(installHost.value, {
        kind: "key",
        title: `Installing key ${selected.value!.name} failed`,
        detail: String(e),
        ok: false,
      });
    }
  } finally {
    installing.value = false;
  }
}

const exportOpen = ref(false);
const exportPassword = ref("");
const exporting = ref(false);
async function exportKey() {
  await withBusy(exporting, async () => {
    const path = await invoke<string>("key_export", {
      id: selected.value!.id,
      password: exportPassword.value,
    });
    toast.add({
      title: "Private key saved",
      description: path,
      icon: "i-ph-download-simple-duotone",
    });
    exportOpen.value = false;
  });
  exportPassword.value = "";
}

const origin = (o: string) =>
  o === "generated" ? "Generated here" : o === "imported" ? "Imported" : "Unknown";
const keySync = computed(() => {
  const k = selected.value;
  if (!k || !sync.url.value) return "local";
  if (sync.skipped.value.includes("key")) return "off";
  return k.dirty || !k.rev ? "waiting" : "synced";
});
const lastSync = computed(() => (sync.ago.value === "not yet" ? "" : sync.ago.value));
const backup = computed(
  () =>
    ({
      local: { chip: "this device", text: "Set up Sync to back it up" },
      off: { chip: "this device", text: "Hosts and keys is off in Sync settings" },
      waiting: { chip: "waiting", text: `Syncs to ${sync.host.value} next` },
      synced: {
        chip: "synced",
        text: `Encrypted in your vault${lastSync.value && `, last ${lastSync.value}`}`,
      },
    })[keySync.value],
);

// Trail built from vault and sync state; no stored log.
const date = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
const history = computed(() => {
  const k = selected.value;
  if (!k) return [];
  const made = k.origin === "generated" ? "Generated on this device" : "Imported into the vault";
  const now = {
    local: [{ text: "Only on this device. Set up Sync to back it up.", when: "" }],
    off: [{ text: "Kept on this device: Hosts & keys is off in Sync settings", when: "" }],
    waiting: [{ text: `Waiting to sync to ${sync.host.value}`, when: "" }],
    synced: [
      {
        text: `Stored on ${sync.host.value} as item rev ${k.rev}`,
        when: lastSync.value && `synced ${lastSync.value}`,
      },
      { text: "Covered by D1 point-in-time restore for 7 days", when: "" },
    ],
  }[keySync.value];
  return [
    { text: k.createdAt ? made : "Added to the vault", when: k.createdAt ? date(k.createdAt) : "" },
    { text: "Sealed with XChaCha20-Poly1305 under your vault key", when: "" },
    ...now,
  ];
});

const importKey = () =>
  withBusy(importing, async () => {
    await invoke("key_import", { ...form });
    await refresh();
    importOpen.value = false;
  });
</script>

<template>
  <div class="flex min-h-0">
    <ListColumn
      v-model:filter="filter"
      title="Keychain"
      :count="keys.length"
      :empty="!shown.length"
    >
      <template #actions>
        <UButton label="Import" size="sm" color="neutral" variant="outline" @click="openImport" />
        <UButton icon="i-ph-plus" label="Generate" size="sm" @click="openGenerate" />
      </template>
      <ListRow
        v-for="k in shown"
        :key="k.id"
        :title="k.name"
        :subtitle="k.fingerprint.replace(/^(SHA256:.{4}).*(.{4})$/, '$1…$2')"
        :selected="selected?.id === k.id"
        @select="selectedId = k.id"
      >
        <UBadge :label="keyAlgorithm(k.algorithm).toLowerCase()" size="sm" class="font-mono" />
        <UBadge :label="`hosts ${usedBy(k.id).length}`" size="sm" class="font-mono" />
      </ListRow>
      <template #empty>
        <EmptyState
          icon="i-ph-key-duotone"
          :filtered="!!keys.length"
          title="No keys yet"
          text="Import a key from ~/.ssh, paste one in, or generate a new one inside the vault."
        />
      </template>
    </ListColumn>

    <main v-if="selected" class="pane max-w-[760px]">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-xl font-semibold">{{ selected.name }}</h2>
        <UBadge
          :label="keyAlgorithm(selected.algorithm).toLowerCase()"
          size="sm"
          class="font-mono"
        />
        <div class="ml-auto flex flex-wrap gap-1.5">
          <UButton
            label="Export…"
            size="sm"
            color="neutral"
            variant="outline"
            @click="((exportOpen = true), (exportPassword = ''))"
          />
          <UButton
            label="Delete"
            size="sm"
            color="neutral"
            variant="ghost"
            @click="remove(selected.id)"
          />
        </div>
      </div>

      <div class="card px-4 py-3.5">
        <dl class="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2 text-xs">
          <dt class="text-muted">Fingerprint</dt>
          <dd class="font-mono break-all">{{ selected.fingerprint }}</dd>
          <dt class="text-muted">Created</dt>
          <dd>{{ selected.createdAt ? date(selected.createdAt) : "Unknown" }}</dd>
          <dt class="text-muted">Origin</dt>
          <dd>{{ origin(selected.origin) }}</dd>
          <dt class="text-muted">Private key</dt>
          <dd>Encrypted in your vault, decrypted only inside the Rust core while connecting</dd>
          <dt class="text-muted">Backup</dt>
          <dd class="flex flex-wrap items-center gap-2">
            <UBadge :label="backup.chip" size="sm" class="font-mono" />
            <span class="text-muted">{{ backup.text }}</span>
          </dd>
        </dl>
      </div>

      <div class="flex flex-col gap-2.5 card px-4 py-3.5">
        <div class="flex items-center gap-2">
          <span class="t-label">Public key</span>
          <UButton
            label="Copy"
            size="xs"
            color="neutral"
            variant="ghost"
            class="ml-auto"
            @click="copyText(selected.publicKey, 'Public key copied')"
          />
        </div>
        <p class="font-mono text-[11px]/relaxed break-all text-toned">{{ selected.publicKey }}</p>
      </div>

      <div class="flex flex-col gap-2.5 card px-4 py-3.5">
        <div class="flex items-center gap-2">
          <span class="t-label">Used by</span>
          <UBadge
            :label="`${usedBy(selected.id).length} ${usedBy(selected.id).length === 1 ? 'host' : 'hosts'}`"
            size="sm"
            class="font-mono"
          />
          <UButton
            label="Install on host…"
            size="sm"
            color="neutral"
            variant="outline"
            class="ml-auto"
            :disabled="!hosts.length"
            @click="openInstall"
          />
        </div>
        <div v-if="usedBy(selected.id).length" class="flex flex-wrap gap-1.5">
          <HostChip
            v-for="h in usedBy(selected.id)"
            :key="h.id"
            :label="hostName(h)"
            :group="h.group"
            class="text-default"
          />
        </div>
        <span class="text-xs text-muted">
          {{
            usedBy(selected.id).length
              ? "Install on host appends the public key to the host's authorized_keys, once."
              : "No host signs in with it yet."
          }}
        </span>
      </div>

      <div class="flex flex-col gap-2.5 card px-4 py-3.5">
        <span class="t-label">Backup trail</span>
        <ol class="flex flex-col gap-1.5 text-xs">
          <li v-for="(step, i) in history" :key="i" class="flex gap-2.5">
            <span class="w-24 shrink-0 text-muted">{{ step.when || "" }}</span>
            <span class="min-w-0 flex-1">{{ step.text }}</span>
          </li>
        </ol>
      </div>
    </main>

    <EmptyLogo v-else />

    <UModal v-model:open="importOpen" title="Import a key">
      <template #body>
        <form id="import-form" class="flex flex-col gap-4" @submit.prevent="importKey">
          <div v-if="found.length" class="flex flex-col gap-2">
            <p class="t-label">Found in ~/.ssh</p>
            <div class="flex flex-wrap gap-2">
              <UButton
                v-for="path in found"
                :key="path"
                :label="path"
                size="xs"
                color="neutral"
                :variant="form.source === path ? 'soft' : 'outline'"
                class="font-mono"
                @click="pick(path)"
              />
            </div>
          </div>
          <UFormField label="Private key" hint="File path, or paste the key">
            <UTextarea
              v-model="form.source"
              :rows="3"
              placeholder="~/.ssh/id_ed25519"
              required
              class="w-full"
              :ui="{ base: 'font-mono text-xs' }"
            />
          </UFormField>
          <div class="flex gap-3">
            <UFormField label="Name" class="flex-1">
              <UInput v-model="form.name" required class="w-full" />
            </UFormField>
            <UFormField label="Passphrase" hint="If it has one" class="flex-1">
              <UInput v-model="form.passphrase" type="password" class="w-full" />
            </UFormField>
          </div>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <span class="text-xs text-dimmed"
            >Stored encrypted in your vault, without the passphrase.</span
          >
          <UButton type="submit" form="import-form" label="Import" :loading="importing" />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="generateOpen" title="Generate a key">
      <template #body>
        <form id="generate-form" class="flex flex-col gap-3" @submit.prevent="generate">
          <UFormField label="Name">
            <UInput v-model="newName" placeholder="deploy-2026" required autofocus class="w-full" />
          </UFormField>
          <p class="text-sm text-muted">
            A new Ed25519 key, created inside the vault. Install it on a host next.
          </p>
        </form>
      </template>
      <template #footer>
        <UButton type="submit" form="generate-form" label="Generate" icon="i-ph-key-duotone" />
      </template>
    </UModal>

    <UModal v-model:open="installOpen" :title="`Install ${selected?.name ?? ''} on a host`">
      <template #body>
        <form id="install-form" class="flex flex-col gap-4" @submit.prevent="installKey">
          <UFormField label="Host">
            <USelect v-model="install.hostId" :items="hostItems" class="w-full" />
          </UFormField>
          <UFormField
            label="Password"
            :hint="
              installHost?.keyId
                ? 'Optional: the host\'s current key is used'
                : 'To sign in this one time'
            "
          >
            <UInput
              v-model="install.password"
              type="password"
              :required="!installHost?.keyId"
              class="w-full"
            />
          </UFormField>
          <UCheckbox
            v-model="install.useForHost"
            :label="`Sign in to ${installHost ? hostName(installHost) : 'it'} with this key from now on`"
          />
          <p class="text-sm text-muted">
            Adds the public key to <span class="font-mono">~/.ssh/authorized_keys</span> on the
            host, once.
          </p>
        </form>
      </template>
      <template #footer>
        <UButton type="submit" form="install-form" label="Install" :loading="installing" />
      </template>
    </UModal>

    <UModal v-model:open="exportOpen" title="Export private key">
      <template #body>
        <form id="export-form" class="flex flex-col gap-3" @submit.prevent="exportKey">
          <p class="text-sm text-muted">
            Writes <span class="font-mono">{{ selected?.name }}</span> and its
            <span class="font-mono">.pub</span> to your Downloads folder, unencrypted. Enter your
            master password to continue.
          </p>
          <UFormField label="Master password">
            <UInput v-model="exportPassword" type="password" required autofocus class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <UButton
          type="submit"
          form="export-form"
          label="Export"
          color="error"
          :loading="exporting"
        />
      </template>
    </UModal>
  </div>
</template>
