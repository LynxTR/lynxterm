<script setup lang="ts">
defineProps<{ text: string; what: string }>();
</script>

<template>
  <button
    type="button"
    :title="`Copy ${what.toLowerCase()}`"
    class="max-w-full cursor-copy text-left transition-colors hover:text-highlighted"
    @click="copyText(text, `${what} copied`)"
  >
    <slot>{{ text }}</slot>
  </button>
</template>
