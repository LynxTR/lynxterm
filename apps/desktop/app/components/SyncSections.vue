<script setup lang="ts">
defineProps<{ showNext?: boolean }>();
const sync = useSync();

const OPTIONS = [
  { label: "Every 5 minutes", value: 5 },
  { label: "Every 15 minutes", value: 15 },
  { label: "Every hour", value: 60 },
  { label: "Daily", value: 1440 },
  { label: "Weekly", value: 10080 },
];
type Section = (typeof SYNC_SECTIONS)[number];
const toggle = (s: Section, on: boolean | "indeterminate") =>
  sync.setEvery(s, on === true ? sync.every(s) : 0);
</script>

<template>
  <ul class="flex flex-col">
    <li
      v-for="s in SYNC_SECTIONS"
      :key="s.id"
      class="flex flex-wrap items-start gap-3 border-t border-default py-2.5 first:border-t-0"
    >
      <UCheckbox
        :model-value="!sync.isOff(s)"
        :disabled="sync.busy.value"
        :label="s.label"
        :description="
          [
            s.hint,
            sync.isOff(s) ? 'Kept on this device' : showNext ? `Next sync ${sync.nextIn(s)}` : '',
          ]
            .filter(Boolean)
            .join('. ')
        "
        class="min-w-0 flex-1"
        @update:model-value="toggle(s, $event)"
      />
      <USelect
        :model-value="sync.every(s)"
        :items="OPTIONS"
        :disabled="sync.busy.value || sync.isOff(s)"
        :aria-label="`How often ${s.label} syncs`"
        size="sm"
        class="w-40"
        @update:model-value="(v) => sync.setEvery(s, Number(v))"
      />
    </li>
  </ul>
</template>
