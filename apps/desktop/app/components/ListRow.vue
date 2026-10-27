<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
  selected?: boolean;
  mono?: boolean;
  dim?: boolean;
  /** Not clickable. */
  plain?: boolean;
}>();
defineEmits<{ select: [] }>();
</script>

<template>
  <li>
    <component
      :is="plain ? 'div' : 'button'"
      class="flex min-h-14 w-full items-center gap-2.5 border-b border-muted px-3.5 py-2 text-left transition-colors"
      :class="[
        selected ? 'bg-row shadow-[inset_3px_0_0_var(--ui-primary)]' : 'hover:bg-row',
        dim && 'text-muted',
      ]"
      @click="plain || $emit('select')"
    >
      <span class="min-w-16 flex-1">
        <span class="block truncate font-medium" :class="mono && 'font-mono text-xs'">{{
          title
        }}</span>
        <span v-if="subtitle" class="block truncate font-mono text-[11px] text-muted">{{
          subtitle
        }}</span>
      </span>
      <!-- pills truncate before title -->
      <span
        v-if="$slots.default"
        class="flex max-w-[60%] min-w-0 shrink items-center justify-end gap-1.5 [&>*]:min-w-0"
      >
        <slot />
      </span>
    </component>
  </li>
</template>
