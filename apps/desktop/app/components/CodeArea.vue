<script setup lang="ts">
// sh editor: transparent textarea over a colored copy of its text. Both in one grid cell,
// cell as wide as longest line, outer box scrolls both together.
defineOptions({ inheritAttrs: false });
defineProps<{ rows: number; indent?: boolean }>();
const code = defineModel<string>({ default: "" });
</script>

<template>
  <div class="code-well">
    <div class="grid w-max min-w-full pe-3" :class="indent ? 'pl-6' : 'pl-2'">
      <pre
        aria-hidden="true"
        class="m-0 whitespace-pre text-highlighted [font:inherit] [grid-area:1/1]"
        v-html="highlightSh(code)"
      />
      <textarea
        v-model="code"
        v-bind="$attrs"
        :rows
        wrap="off"
        spellcheck="false"
        class="code-input [grid-area:1/1]"
      />
    </div>
  </div>
</template>
