<script setup lang="ts">
defineProps<{ title: string; chip?: string }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <aside
    :aria-label="title"
    class="flex w-[340px] shrink-0 flex-col border-l border-default bg-muted"
  >
    <div class="flex items-center gap-2 border-b border-default px-3.5 py-2.5">
      <span class="t-section">{{ title }}</span>
      <UBadge v-if="chip" :label="chip" size="sm" class="font-mono" />
      <UButton
        icon="i-ph-x"
        size="xs"
        color="neutral"
        variant="ghost"
        :aria-label="`Close ${title.toLowerCase()}`"
        class="ml-auto"
        @click="$emit('close')"
      />
    </div>
    <slot />
  </aside>
</template>
