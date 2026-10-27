<script setup lang="ts">
// `filtered`: list has items, filter hides them all.
defineProps<{ icon: string; title?: string; text: string; filtered?: boolean }>();
</script>

<template>
  <main
    class="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-accented p-8 text-center"
  >
    <UIcon :name="icon" class="size-8 text-dimmed" />
    <p v-if="filtered || title" class="font-semibold">{{ filtered ? "No match" : title }}</p>
    <p class="max-w-sm text-sm text-muted">
      {{ filtered ? "Nothing matches the filter." : text }}
    </p>
  </main>
</template>
