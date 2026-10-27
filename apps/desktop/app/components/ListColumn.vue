<script setup lang="ts">
defineProps<{
  title: string;
  count: number;
  empty?: boolean;
  placeholder?: string;
}>();
const filter = defineModel<string>("filter", { default: "" });
const field = useTemplateRef<{ inputRef?: HTMLInputElement }>("field");
defineExpose({ focus: () => field.value?.inputRef?.focus() });
</script>

<template>
  <UDashboardPanel
    :id="title.toLowerCase().replace(/\W+/g, '-')"
    resizable
    :min-size="260"
    :default-size="340"
    :max-size="480"
    :ui="{
      root: 'min-h-0 w-(--width) bg-sunken not-last:border-e not-last:border-default',
      body: 'gap-0 p-0 sm:p-0',
    }"
  >
    <template #header>
      <UDashboardNavbar
        :title="title"
        :toggle="false"
        :ui="{ root: 'border-b-0 px-4 sm:px-4', title: 'text-[15px]' }"
      >
        <template #trailing>
          <UBadge :label="String(count)" size="sm" class="font-mono" />
        </template>
        <template #right><slot name="actions" /></template>
      </UDashboardNavbar>
      <UDashboardToolbar :ui="{ root: ['min-h-11 px-3 sm:px-3', $slots.filters && 'border-b-0'] }">
        <UInput
          ref="field"
          v-model="filter"
          icon="i-ph-magnifying-glass-duotone"
          :placeholder="placeholder ?? 'Filter'"
          :aria-label="`Filter ${title.toLowerCase()}`"
          size="sm"
          class="w-full"
        >
          <template v-if="$slots.kbd" #trailing><slot name="kbd" /></template>
        </UInput>
      </UDashboardToolbar>
      <div v-if="$slots.filters" class="border-b border-default px-3 pt-1.5 pb-3">
        <slot name="filters" />
      </div>
    </template>
    <template #body>
      <div v-if="empty" class="p-3"><slot name="empty" /></div>
      <ul v-else class="flex flex-col">
        <slot />
      </ul>
    </template>
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </UDashboardPanel>
</template>
