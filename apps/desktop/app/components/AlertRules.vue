<script setup lang="ts">
// Edits defaults (Settings › Monitoring) or a host's override. With `inherit`, rows without
// "custom" ticked follow defaults, greyed out.

const rules = defineModel<Partial<Record<Metric, Rule>>>({ required: true });
const props = defineProps<{ inherit?: Record<Metric, Rule> }>();

const ruleOf = (m: Metric) => rules.value[m] ?? props.inherit![m];
function setCustom(m: Metric, on: boolean | "indeterminate") {
  if (on === true) rules.value[m] = { ...props.inherit![m] };
  else delete rules.value[m];
}
const num = (v: string | number) => Math.max(0, Number(v) || 0);

type Field = {
  key: "above" | "for" | "clear";
  label: string;
  unit: string;
  min: number;
  max?: number;
  step?: number;
  clamp: (v: number) => number;
};
function cells(m: (typeof METRICS)[number]): (Field | string)[] {
  const r = ruleOf(m.id);
  if (m.id === "unreachable")
    return [
      "no answer",
      {
        key: "for",
        label: "after minutes",
        unit: "min",
        min: 1,
        clamp: (v) => Math.max(1, v),
      },
      "first good sample",
    ];
  const step = m.id === "load" ? 0.1 : 1;
  const percent = m.unit === "%";
  return [
    {
      key: "above",
      label: "above",
      unit: m.unit,
      min: step,
      max: percent ? 100 : undefined,
      step,
      clamp: (v) => (percent ? Math.min(100, v) : v),
    },
    {
      key: "for",
      label: "for minutes",
      unit: r.for ? "min" : "at once",
      min: 0,
      clamp: (v) => v,
    },
    {
      key: "clear",
      label: "clears below",
      unit: m.unit,
      min: 0,
      step,
      clamp: (v) => Math.min(r.above, v),
    },
  ];
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="text-left">
          <th v-if="inherit" class="t-label w-20 px-3 py-2.5">Custom</th>
          <th class="w-14 px-3 py-2.5"><span class="sr-only">On</span></th>
          <th class="t-label px-3 py-2.5">Metric</th>
          <th class="t-label px-3 py-2.5">Above</th>
          <th class="t-label px-3 py-2.5">For</th>
          <th class="t-label px-3 py-2.5">Clears below</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="m in METRICS"
          :key="m.id"
          class="border-t border-default"
          :class="inherit && !rules[m.id] && 'text-dimmed'"
        >
          <td v-if="inherit" class="px-3 py-2">
            <UCheckbox
              :model-value="!!rules[m.id]"
              :aria-label="`Custom ${m.label} rule`"
              @update:model-value="setCustom(m.id, $event)"
            />
          </td>
          <td class="px-3 py-2">
            <USwitch
              :model-value="ruleOf(m.id).on"
              :disabled="inherit && !rules[m.id]"
              :aria-label="`${m.label} alert`"
              @update:model-value="rules[m.id]!.on = $event"
            />
          </td>
          <td class="px-3 py-2 whitespace-nowrap">{{ m.label }}</td>
          <td v-for="c in cells(m)" :key="typeof c === 'string' ? c : c.key" class="px-3 py-2">
            <span v-if="typeof c === 'string'" class="text-xs text-muted">{{ c }}</span>
            <span v-else class="flex items-center gap-1.5">
              <UInput
                :model-value="ruleOf(m.id)[c.key]"
                type="number"
                :min="c.min"
                :max="c.max"
                :step="c.step"
                size="sm"
                class="w-20"
                :disabled="(inherit && !rules[m.id]) || !ruleOf(m.id).on"
                :aria-label="`${m.label} ${c.label}`"
                :ui="{ base: 'font-mono text-right' }"
                @update:model-value="rules[m.id]![c.key] = c.clamp(num($event))"
              />
              <span class="text-xs text-muted">{{ c.unit }}</span>
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
