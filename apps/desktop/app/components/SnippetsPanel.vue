<script setup lang="ts">
const emit = defineEmits<{ close: [] }>();
const { snippets } = useSnippets();
const { current, activePane, runSnippet } = useSessions();
const view = useView();
const disabled = computed(() => activePane.value?.session === undefined);
const { filter, shown } = useFilter(
  () => snippets.value,
  (s) => `${s.name} ${s.command}`,
);
function manage() {
  current.value = null;
  view.value = "snippets";
}
</script>

<template>
  <ToolPanel title="Snippets" :chip="String(snippets.length)" @close="emit('close')">
    <div class="border-b border-default px-3.5 py-2.5">
      <UInput
        v-model="filter"
        icon="i-ph-magnifying-glass-duotone"
        placeholder="Filter"
        aria-label="Filter snippets"
        size="sm"
        class="w-full"
      />
    </div>
    <ul class="min-h-0 flex-1 overflow-y-auto">
      <li
        v-for="s in shown"
        :key="s.id ?? s.name"
        class="flex items-center gap-3 border-b border-muted px-3.5 py-2 hover:bg-elevated"
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ s.name }}</span>
          <span class="block truncate font-mono text-xs text-muted">{{ s.command }}</span>
        </span>
        <UButton
          label="Run"
          size="xs"
          color="neutral"
          variant="outline"
          :disabled="disabled"
          :title="disabled ? 'Waiting for the session to connect' : 'Type into the terminal'"
          @click="runSnippet(s)"
        />
      </li>
      <li v-if="!shown.length" class="p-4">
        <EmptyState
          icon="i-ph-code-duotone"
          :filtered="!!snippets.length"
          title="No snippets yet"
          text="Save commands you run often. They show up here and as suggestions in every terminal."
        />
      </li>
    </ul>
    <div class="border-t border-default p-2.5">
      <UButton
        label="Manage snippets"
        icon="i-ph-sliders-horizontal-duotone"
        size="xs"
        color="neutral"
        variant="outline"
        class="w-full"
        @click="manage"
      />
    </div>
  </ToolPanel>
</template>
