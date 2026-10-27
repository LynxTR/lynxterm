<script setup lang="ts">
const { knownHosts, refresh, remove } = useKnownHosts();
const { hosts } = useHosts();
const toast = useToast();

const name = (h: KnownHost) =>
  h.hosts ? h.hosts.split(",").map(maskHost).join(", ") : "Hashed entry";
const keyOf = (h: KnownHost) => `${h.line}-${h.fingerprint}`;
const savedFor = (h: KnownHost) =>
  hosts.value.find((s) =>
    h.hosts.split(",").some((n) => n === s.host || n === `[${s.host}]:${s.port}`),
  );

const { filter, shown } = useFilter(
  () => knownHosts.value,
  (h) => `${h.hosts} ${h.fingerprint}`,
);
const selectedKey = ref<string | null>(null);
const selected = computed(
  () => knownHosts.value.find((h) => keyOf(h) === selectedKey.value) ?? knownHosts.value[0],
);

async function forget() {
  const h = selected.value!;
  const ok = await askConfirm({
    title: `Forget ${name(h)}?`,
    description: `Removes line ${h.line} from ~/.ssh/known_hosts. The next connection shows the trust prompt again. Do this only after a server reinstall or a deliberate key rotation.`,
    detail: h.fingerprint,
    label: "Forget",
  });
  if (!ok) return;
  try {
    await remove(h);
  } catch (e) {
    toast.add({ title: String(e), color: "error" });
    await refresh();
  }
}
</script>

<template>
  <div class="flex min-h-0">
    <ListColumn
      v-model:filter="filter"
      title="Known hosts"
      :count="knownHosts.length"
      :empty="!shown.length"
    >
      <template #actions>
        <UButton
          icon="i-ph-arrows-clockwise"
          size="sm"
          color="neutral"
          variant="ghost"
          aria-label="Reload from disk"
          title="Reload from disk"
          @click="refresh"
        />
      </template>
      <ListRow
        v-for="h in shown"
        :key="keyOf(h)"
        mono
        :title="name(h)"
        :subtitle="h.fingerprint.replace(/^(SHA256:.{4}).*(.{4})$/, '$1…$2')"
        :selected="selected && keyOf(selected) === keyOf(h)"
        :dim="!savedFor(h)"
        @select="selectedKey = keyOf(h)"
      >
        <UBadge :label="keyAlgorithm(h.algorithm).toLowerCase()" size="sm" class="font-mono" />
        <HostChip v-if="savedFor(h)" :label="hostName(savedFor(h)!)" :group="savedFor(h)!.group" />
        <UBadge v-else label="no host" size="sm" class="font-mono" />
      </ListRow>
      <template #empty>
        <EmptyState
          icon="i-ph-shield-check-duotone"
          :filtered="!!knownHosts.length"
          title="No trusted keys yet"
          text="Server keys land here as you connect to new servers and trust them."
        />
      </template>
    </ListColumn>

    <main v-if="selected" class="pane max-w-[760px]">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="min-w-0 font-mono text-xl font-semibold break-all">{{ name(selected) }}</h2>
        <UBadge :label="keyAlgorithm(selected.algorithm)" class="font-mono" />
        <div class="ml-auto flex gap-2">
          <UButton
            icon="i-ph-copy-duotone"
            label="Copy fingerprint"
            color="neutral"
            variant="outline"
            @click="copyText(selected.fingerprint, 'Fingerprint copied')"
          />
          <UButton label="Forget" color="neutral" variant="ghost" @click="forget" />
        </div>
      </div>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4">
        <div class="flex flex-col gap-2 card p-4">
          <p class="t-label">Fingerprint</p>
          <p class="font-mono text-xs break-all">{{ selected.fingerprint }}</p>
          <p class="t-label pt-2">Aliases</p>
          <div class="flex flex-wrap gap-1.5">
            <UBadge
              v-for="a in selected.hosts ? selected.hosts.split(',') : ['hashed']"
              :key="a"
              :label="maskHost(a)"
              size="sm"
              class="font-mono"
            />
          </div>
          <p class="t-label pt-2">File</p>
          <p class="flex items-center gap-2 font-mono text-xs">
            ~/.ssh/known_hosts
            <UBadge :label="`line ${selected.line}`" size="sm" />
          </p>
          <template v-if="savedFor(selected)">
            <p class="t-label pt-2">Used by</p>
            <p class="font-mono text-xs">{{ hostName(savedFor(selected)!) }}</p>
          </template>
        </div>

        <div class="flex flex-col gap-3 card p-4">
          <span class="t-section">How it protects you</span>
          <p class="text-sm leading-5 text-muted">
            If this server ever presents a different key, Lynxterm refuses to connect: that is what
            a man-in-the-middle looks like. Forget the entry only if you know the server was
            reinstalled or rotated its key.
          </p>
          <p v-if="!selected.hosts" class="text-sm leading-5 text-muted">
            OpenSSH stored this name hashed, so it can't be shown.
          </p>
        </div>
      </div>

      <p class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-info-duotone" class="size-[18px]" />
        Read from ~/.ssh/known_hosts on this machine; not synced. "no host" means no saved host in
        Lynxterm uses that address.
      </p>
    </main>

    <EmptyLogo v-else />
  </div>
</template>
