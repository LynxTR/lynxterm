<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { SshTarget } from "~/components/SshTerminal.vue";

const props = defineProps<{ session?: number; target?: SshTarget }>();
const log = (entry: Omit<Activity, "at">) => props.target && logActivity(props.target, entry);
const emit = defineEmits<{ close: [] }>();
const toast = useToast();

type Entry = { name: string; isDir: boolean; size: number };
const path = ref("");
const entries = ref<Entry[]>([]);
const loading = ref(false);
const error = ref("");

async function load(to = path.value) {
  if (props.session === undefined) return;
  loading.value = true;
  error.value = "";
  try {
    const listing = await invoke<{ path: string; entries: Entry[] }>("sftp_list", {
      id: props.session,
      path: to,
    });
    path.value = listing.path;
    entries.value = listing.entries;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

// New session (other tab or pane) starts at its home folder.
watch(
  () => props.session,
  () => load(""),
  { immediate: true },
);

const join = (name: string) => `${path.value.replace(/\/$/, "")}/${name}`;
const up = () => load(path.value.replace(/\/[^/]*$/, "") || "/");
const atTop = computed(() => !path.value || path.value === "/");

const typed = ref("");
watch(path, (p) => (typed.value = p));

async function open(entry: Entry) {
  if (entry.isDir) return load(join(entry.name));
  try {
    const saved = await invoke<string>("sftp_download", {
      id: props.session,
      path: join(entry.name),
    });
    toast.add({ title: "Downloaded", description: saved, icon: "i-ph-download-simple-duotone" });
    log({ kind: "download", title: `Downloaded ${entry.name}`, detail: `from ${path.value}` });
  } catch (e) {
    toast.add({ title: String(e), color: "error" });
    log({
      kind: "download",
      title: `Download of ${entry.name} failed`,
      detail: String(e),
      ok: false,
    });
  }
}

// Drops anywhere on window upload to shown folder.
const dropping = ref(false);
let unlisten: (() => void) | undefined;
onMounted(async () => {
  unlisten = await getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    if (payload.type === "over") return (dropping.value = true);
    dropping.value = false;
    if (payload.type !== "drop" || props.session === undefined || !path.value) return;
    for (const local of payload.paths) {
      try {
        await invoke("sftp_upload", { id: props.session, local, dir: path.value });
        log({ kind: "upload", title: `Uploaded ${baseName(local)}`, detail: `to ${path.value}` });
      } catch (e) {
        toast.add({ title: String(e), color: "error" });
        log({
          kind: "upload",
          title: `Upload of ${baseName(local)} failed`,
          detail: String(e),
          ok: false,
        });
      }
    }
    toast.add({ title: `Uploaded to ${path.value}`, icon: "i-ph-upload-simple-duotone" });
    load();
  });
});
onBeforeUnmount(() => unlisten?.());

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

function size(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.max(n, 1)) / Math.log(1024)));
  return `${i ? (n / 1024 ** i).toFixed(1) : n} ${units[i]}`;
}
</script>

<template>
  <ToolPanel
    title="SFTP"
    :chip="target && hostName(target)"
    :class="dropping && 'ring-2 ring-primary ring-inset'"
    @close="emit('close')"
  >
    <form
      class="flex items-center gap-1 border-b border-default px-2 py-1.5"
      @submit.prevent="load(typed.trim() || '/')"
    >
      <UButton
        icon="i-ph-arrow-up"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="Parent folder"
        :disabled="atTop"
        @click="up"
      />
      <UButton
        icon="i-ph-house-duotone"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="Home folder"
        @click="load('')"
      />
      <UInput
        v-model="typed"
        size="xs"
        variant="ghost"
        placeholder="/"
        aria-label="Folder path"
        spellcheck="false"
        class="min-w-0 flex-1"
        :ui="{ base: 'font-mono text-xs' }"
      />
      <UButton
        icon="i-ph-arrows-clockwise"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="Refresh"
        :loading="loading"
        @click="load()"
      />
    </form>

    <p v-if="session === undefined" class="p-4 text-sm text-muted">
      Waiting for the session to connect…
    </p>
    <div v-else-if="error" class="p-3">
      <UAlert color="error" variant="subtle" icon="i-ph-warning-circle-duotone" :title="error" />
    </div>
    <ul v-else class="min-h-0 flex-1 overflow-y-auto">
      <li v-if="!atTop">
        <button
          class="flex min-h-10 w-full items-center gap-2.5 border-b border-muted px-3.5 py-1.5 text-left hover:bg-elevated"
          title="Parent folder"
          @click="up"
        >
          <UIcon name="i-ph-arrow-elbow-left-up" class="size-4 shrink-0 text-muted" />
          <span class="font-mono text-xs">..</span>
        </button>
      </li>
      <li v-for="entry in entries" :key="entry.name" class="group">
        <button
          class="flex min-h-10 w-full items-center gap-2.5 border-b border-muted px-3.5 py-1.5 text-left hover:bg-elevated"
          :title="entry.isDir ? 'Open folder' : 'Download to your Downloads folder'"
          @click="open(entry)"
        >
          <UIcon
            :name="entry.isDir ? 'i-ph-folder-duotone' : 'i-ph-file-duotone'"
            class="size-4 shrink-0"
            :class="entry.isDir ? 'text-primary' : 'text-muted'"
          />
          <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ entry.name }}</span>
          <span v-if="!entry.isDir" class="font-mono text-[11px] text-dimmed">{{
            size(entry.size)
          }}</span>
          <UIcon
            v-if="!entry.isDir"
            name="i-ph-download-simple-duotone"
            class="size-4 text-dimmed opacity-0 group-hover:opacity-100"
          />
        </button>
      </li>
      <li v-if="!loading && !entries.length" class="p-3 text-sm text-muted">Empty folder</li>
    </ul>

    <p class="border-t border-dashed border-default px-3.5 py-2.5 text-center text-xs text-dimmed">
      Click a file to download it. Drop files anywhere to upload them here.
    </p>
  </ToolPanel>
</template>
