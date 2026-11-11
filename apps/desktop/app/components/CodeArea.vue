<script setup lang="ts">
// Transparent textarea over colored copy, one grid cell: cell as wide as longest line, outer
// box scrolls both.
defineOptions({ inheritAttrs: false });
defineProps<{
  from: number;
  mark: (n: number) => unknown;
  placeholder?: string;
  indent?: boolean;
}>();
const code = defineModel<string>({ default: "" });
const lines = (text: string) => text.split("\n").length;
</script>

<template>
  <div class="flex">
    <span class="code-gutter">
      <span v-for="i in lines(code)" :key="i" class="block" :class="mark(from + i - 1)">{{
        from + i - 1
      }}</span>
    </span>
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
          :placeholder
          :rows="lines(code || placeholder || '')"
          wrap="off"
          spellcheck="false"
          class="code-input [grid-area:1/1]"
        />
      </div>
    </div>
  </div>
</template>
