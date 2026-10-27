<script setup lang="ts">
const { snippets, save, remove } = useSnippets();
const { usedOn } = useHistory();

const { filter, shown } = useFilter(
  () => snippets.value,
  (s) => `${s.name} ${s.command}`,
);
const { draft, submit } = useDraft(snippets, save, "Snippet saved");

async function forget() {
  const s = draft.value!;
  const ok = await askConfirm({
    title: `Delete ${s.name}?`,
    description: "Removes the snippet from your vault on every device.",
    detail: s.command,
  });
  if (!ok) return;
  draft.value = null;
  await remove(s.id!);
}

const runCount = (s: Snippet) => usedOn(s.command);
const ranOn = (s: Snippet) => `ran on ${runCount(s)} ${runCount(s) === 1 ? "host" : "hosts"}`;
</script>

<template>
  <div class="flex min-h-0">
    <ListColumn
      v-model:filter="filter"
      title="Snippets"
      :count="snippets.length"
      :empty="!shown.length"
    >
      <template #actions>
        <UButton
          icon="i-ph-plus"
          label="New snippet"
          size="sm"
          @click="draft = { name: '', command: '' }"
        />
      </template>
      <ListRow
        v-for="s in shown"
        :key="s.id"
        :title="s.name"
        :subtitle="s.command"
        :selected="draft?.id === s.id"
        @select="draft = { ...s }"
      >
        <UBadge v-if="runCount(s)" :label="ranOn(s)" size="sm" class="font-mono" />
      </ListRow>
      <template #empty>
        <EmptyState
          icon="i-ph-code-duotone"
          :filtered="!!snippets.length"
          title="No snippets yet"
          text="Save commands you run often. They show up as suggestions in every terminal and in the Snippets panel."
        />
      </template>
    </ListColumn>

    <main v-if="draft" class="pane max-w-[760px]">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-xl font-semibold">{{ draft.name || "New snippet" }}</h2>
        <UBadge v-if="draft.id && runCount(draft)" :label="ranOn(draft)" class="font-mono" />
        <div v-if="draft.id" class="ml-auto flex flex-wrap gap-2">
          <UButton
            icon="i-ph-copy-duotone"
            label="Copy command"
            color="neutral"
            variant="outline"
            @click="copyText(draft.command, 'Command copied')"
          />
          <UButton
            icon="i-ph-copy-duotone"
            label="Duplicate"
            color="neutral"
            variant="ghost"
            @click="draft = { name: `${draft.name} copy`, command: draft.command }"
          />
          <UButton
            icon="i-ph-trash-duotone"
            label="Delete"
            color="neutral"
            variant="ghost"
            @click="forget"
          />
        </div>
      </div>

      <form class="flex max-w-3xl flex-col gap-4 card p-4" @submit.prevent="submit">
        <UFormField label="Name">
          <UInput v-model="draft.name" placeholder="Tail app logs" required class="w-full" />
        </UFormField>
        <UFormField label="Command" hint="Sent to the terminal, then Enter">
          <UTextarea
            v-model="draft.command"
            :rows="6"
            required
            placeholder="docker compose logs -f --tail 100"
            class="w-full"
            :ui="{ base: 'font-mono text-xs' }"
          />
        </UFormField>
        <UButton type="submit" label="Save" class="self-end" />
      </form>

      <p class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-info-duotone" class="size-[18px]" />
        Run it from the Snippets panel beside any open terminal, or from the ⌘K palette.
      </p>
    </main>

    <EmptyLogo v-else />
  </div>
</template>
