<script setup lang="ts">
defineProps<{ label: string; group?: string }>();
</script>

<template>
  <UBadge :label="label" size="sm" class="font-mono">
    <template #leading>
      <span
        class="size-1.5 shrink-0 rounded-full"
        :style="{ backgroundColor: groupColor(group) || 'var(--ui-border-accented)' }"
      />
    </template>
  </UBadge>
</template>
