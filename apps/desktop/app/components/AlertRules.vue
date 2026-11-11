<script setup lang="ts">
const rules = defineModel<Partial<Record<Metric, Rule>>>({ required: true });
const props = defineProps<{ inherit?: Record<Metric, Rule> }>();

const ruleOf = (m: Metric) => rules.value[m] ?? props.inherit![m];
function setCustom(m: Metric, on: boolean | "indeterminate") {
  if (on === true) rules.value[m] = { ...props.inherit![m] };
  else delete rules.value[m];
}
type Field = {
  key: "above" | "for" | "clear";
  label: string;
  unit: string;
  min: number;
  max?: number;
  step?: number;
};
function cells(m: (typeof METRICS)[number]): (Field | string)[] {
  const r = ruleOf(m.id);
  if (m.id === "unreachable")
    return [
      "no answer",
      { key: "for", label: "after minutes", unit: "min", min: 1 },
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
    },
    { key: "for", label: "for minutes", unit: r.for ? "min" : "at once", min: 0 },
    { key: "clear", label: "clears below", unit: m.unit, min: 0, max: r.above, step },
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
              <UInputNumber
                :model-value="ruleOf(m.id)[c.key]"
                :min="c.min"
                :max="c.max"
                :step="c.step"
                :increment="false"
                :decrement="false"
                size="sm"
                class="w-20"
                :disabled="(inherit && !rules[m.id]) || !ruleOf(m.id).on"
                :aria-label="`${m.label} ${c.label}`"
                :ui="{ base: 'font-mono text-right' }"
                @update:model-value="rules[m.id]![c.key] = $event ?? c.min"
              />
              <span class="text-xs text-muted">{{ c.unit }}</span>
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
