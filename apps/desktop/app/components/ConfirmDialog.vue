<script lang="ts">
export type Ask = {
  title: string;
  description?: string;
  /** Mono line under description: fingerprint, path, command. */
  detail?: string;
  /** Danger button label; default "Delete". */
  label?: string;
};
</script>

<script setup lang="ts">
const ask = defineProps<Ask>();
const emit = defineEmits<{ close: [ok: boolean] }>();
</script>

<template>
  <UModal :title="ask.title" :description="ask.description">
    <template v-if="ask.detail" #body>
      <p class="rounded-md border border-default bg-default px-3 py-2 font-mono text-xs text-muted">
        {{ ask.detail }}
      </p>
    </template>
    <template #footer>
      <form class="flex w-full justify-end gap-2" @submit.prevent="emit('close', true)">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('close', false)">
          <template #trailing><UKbd value="Esc" /></template>
        </UButton>
        <UButton type="submit" :label="ask.label ?? 'Delete'" color="error" autofocus>
          <template #trailing><UKbd value="↵" /></template>
        </UButton>
      </form>
    </template>
  </UModal>
</template>
