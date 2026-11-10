<script setup lang="ts">
const props = defineProps<{ os?: string }>();
const logo = computed(() => osLogo(props.os));
</script>

<template>
  <span
    class="flex size-11 shrink-0 items-center justify-center rounded-[10px]"
    :class="logo ? '' : 'bg-elevated text-muted'"
    :style="logo && { backgroundColor: logo.bg, color: logo.dark ? '#1a1200' : '#fff' }"
    role="img"
    :aria-label="os || 'Unknown system'"
  >
    <Icon v-if="logo" :name="logo.icon" :customize="false" class="size-6" />
    <UIcon v-else name="i-ph-hard-drives-duotone" class="size-6" />
  </span>
</template>
