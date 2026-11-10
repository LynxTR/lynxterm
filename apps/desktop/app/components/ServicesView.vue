<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { watchDebounced } from "@vueuse/core";

const { services, available, save, remove } = useServices();

const { filter, shown: matching } = useFilter(
  () => available.value,
  (s) => `${s.name} ${s.description}`,
);
const shown = computed(() => matching.value.filter((s) => !isBuiltIn(s)));
const { draft, submit } = useDraft(services, save, "Service saved");
/** A built-in opens as a new draft: saving makes an own copy, never changes the built-in. */
const pick = (s: Service) =>
  (draft.value = { ...structuredClone(toRaw(s)), id: isBuiltIn(s) ? undefined : s.id });
const EVERY = [
  { label: "Off", value: 0 },
  { label: "5 minutes", value: 5 },
  { label: "15 minutes", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "1 day", value: 1440 },
];
const everyLabel = (n: number) => EVERY.find((e) => e.value === n)?.label ?? `${n} minutes`;
const builtIn = computed(() => matching.value.filter(isBuiltIn));

function duplicate() {
  const s = structuredClone(toRaw(draft.value!));
  draft.value = { ...s, id: undefined, name: `${s.name} copy` };
}

async function forget() {
  const s = draft.value!;
  const ok = await askConfirm({
    title: `Delete ${s.name}?`,
    description:
      "Removes the service from your vault on every device. Servers keep what it installed.",
  });
  if (!ok) return;
  draft.value = null;
  await remove(s.id!);
}

// Built-in with draft's name. Not saved: draft is that built-in, saving makes own copy that
// replaces it. Saved: own copy hides it and misses its updates; deleting brings it back.
const template = computed(() => serviceTemplates.find((t) => t.name === draft.value?.name));
async function reset() {
  const s = draft.value!;
  const t = template.value;
  if (!t) return;
  const ok = await askConfirm({
    title: `Reset ${s.name} to the built-in?`,
    description:
      "Deletes your edited copy on every device. The built-in takes its place, and follows LynxTerm updates. Servers keep what it installed.",
    label: "Reset",
  });
  if (!ok) return;
  await remove(s.id!);
  pick(t);
}

const SHARED_EXAMPLE = 'PKGS="docker-ce docker-ce-cli containerd.io"';
const count = (text: string | undefined) => (text ?? "").split("\n").length;
const rows = (body: string | undefined, example: string) => count(body || example);
const numbers = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

/** First body line of each part, as in serviceFile: line 1 shared comment, then per function
 *  header, body, closing. */
const at = computed(() => {
  const d = draft.value!;
  let n = 2;
  const first: Record<string, number> = { shared: n };
  n += count(d.shared);
  for (const f of SERVICE_FUNCTIONS) {
    if (d.functions[f.name] === undefined) continue;
    first[f.name] = n + 1;
    n += count(d.functions[f.name]) + 2;
  }
  first.end = n;
  return first;
});

const code = useTemplateRef<HTMLElement>("code");
async function add(f: ServiceFunction) {
  draft.value!.functions[f] = "";
  await nextTick();
  code.value?.querySelector<HTMLElement>(`[data-fn="${f}"]`)?.focus();
}
const drop = (f: ServiceFunction) => delete draft.value!.functions[f];

const rawMode = ref(false);
const raw = ref("");
const splitError = ref<{ line: number; error: string } | null>(null);
watch(draft, (d) => rawMode.value && d && (raw.value = serviceFile(d)));
watch(raw, () => (splitError.value = null));
function applyRaw() {
  const parts = parseServiceFile(raw.value);
  if ("error" in parts) {
    splitError.value = parts;
    return false;
  }
  Object.assign(draft.value!, parts);
  return true;
}
function setRaw(on: boolean) {
  if (on === rawMode.value) return;
  if (on) raw.value = serviceFile(draft.value!);
  else if (!applyRaw()) return;
  rawMode.value = on;
}
async function onSubmit() {
  if (!rawMode.value || applyRaw()) await submit();
}

const script = computed(
  () => draft.value && (rawMode.value ? raw.value : serviceFile(draft.value)),
);
const warnings = computed(() => (script.value ? lintServiceFile(script.value) : []));

// Syntax: local sh -n as you type. undefined: not checked yet; null: valid.
const syntax = ref<{ line: number; error: string } | null>();
const unavailable = ref("");
watchDebounced(
  script,
  async (script) => {
    if (script == null) return;
    try {
      const message = await invoke<string | null>("service_check", { script });
      syntax.value = message ? shError(message) : null;
    } catch (e) {
      unavailable.value = String(e);
    }
  },
  { debounce: 400, immediate: true },
);
const problem = computed(() => splitError.value ?? syntax.value);
const warned = computed(() => new Set(warnings.value.map((w) => w.line)));
const fixable = computed(() => warnings.value.filter((w) => w.fixed !== undefined).length);
function setScript(text: string) {
  if (rawMode.value) return void (raw.value = text);
  const parts = parseServiceFile(text);
  if (!("error" in parts)) Object.assign(draft.value!, parts);
}
const mark = (n: number) =>
  problem.value?.line === n
    ? "font-semibold text-error!"
    : warned.value.has(n) && "font-semibold text-warning!";
</script>

<template>
  <div class="flex min-h-0">
    <ListColumn
      v-model:filter="filter"
      title="Services"
      :count="services.length"
      :empty="!shown.length && !builtIn.length"
    >
      <template #actions>
        <UButton
          color="primary"
          icon="i-ph-plus"
          label="New service"
          size="sm"
          @click="draft = newService()"
        />
      </template>
      <ListRow
        v-for="s in shown"
        :key="s.id"
        :title="s.name"
        :subtitle="s.description"
        :selected="draft?.id === s.id"
        @select="pick(s)"
      >
        <UBadge v-if="s.checkOnConnect" label="on connect" size="sm" class="font-mono" />
        <UBadge
          v-if="s.checkEvery"
          :label="`every ${everyLabel(s.checkEvery)}`"
          size="sm"
          class="font-mono"
        />
      </ListRow>
      <template v-if="builtIn.length">
        <li class="t-label px-3.5 pt-5 pb-2">Built-in</li>
        <ListRow
          v-for="t in builtIn"
          :key="t.name"
          :title="t.name"
          :subtitle="t.description"
          :selected="!draft?.id && draft?.name === t.name"
          @select="pick(t)"
        />
      </template>
      <template #empty>
        <EmptyState
          icon="i-ph-cube-duotone"
          :filtered="!!(services.length + serviceTemplates.length)"
          title="No services yet"
          text="Describe how to detect, install, and check something on your servers, like Docker or nginx."
        />
      </template>
    </ListColumn>

    <main v-if="draft" :key="draft.id ?? 'new'" class="pane max-w-[900px]">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="t-heading">{{ draft.name || "New service" }}</h2>
        <UBadge
          v-if="!draft.id"
          :label="template ? 'built-in' : 'not saved yet'"
          class="font-mono"
        />
        <div v-if="draft.id" class="ml-auto flex flex-wrap gap-2">
          <UButton
            v-if="template"
            icon="i-ph-arrow-counter-clockwise-duotone"
            label="Reset to built-in"
            variant="ghost"
            @click="reset"
          />
          <UButton icon="i-ph-copy-duotone" label="Duplicate" variant="ghost" @click="duplicate" />
          <UButton icon="i-ph-trash-duotone" label="Delete" variant="ghost" @click="forget" />
        </div>
      </div>

      <form class="flex flex-col gap-4" @submit.prevent="onSubmit">
        <div class="box max-w-none gap-4 p-4">
          <div class="flex flex-wrap gap-4">
            <UFormField label="Name" class="w-56">
              <UInput v-model="draft.name" placeholder="Docker" required class="w-full" />
            </UFormField>
            <UFormField label="Description" class="min-w-60 flex-1">
              <UInput
                v-model="draft.description"
                placeholder="Docker Engine from Docker's apt repo"
                class="w-full"
              />
            </UFormField>
          </div>
          <div class="flex flex-wrap items-start gap-x-8 gap-y-4">
            <UCheckbox
              v-model="draft.checkOnConnect"
              label="Check on connect"
              description="Runs detect, then check, when a terminal connects to any host."
              class="min-w-60 flex-1"
            />
            <UFormField
              label="Check every"
              description="While LynxTerm is open, on hosts with a key or saved password."
              class="min-w-60 flex-1"
            >
              <USelect
                v-model="draft.checkEvery"
                :items="EVERY"
                size="sm"
                class="w-40"
                aria-label="Check every"
              />
            </UFormField>
          </div>
        </div>

        <div
          ref="code"
          class="overflow-hidden rounded-[10px] border border-accented font-mono text-xs/5 [font-variant-ligatures:none]"
        >
          <div class="flex h-10 items-center border-b border-accented bg-sunken px-3 font-sans">
            <span class="t-label">Code</span>
            <UFieldGroup size="xs" class="ml-auto">
              <UButton
                label="Functions"
                :variant="rawMode ? 'outline' : 'soft'"
                :aria-pressed="!rawMode"
                @click="setRaw(false)"
              />
              <UButton
                label="Raw file"
                :variant="rawMode ? 'soft' : 'outline'"
                :aria-pressed="rawMode"
                @click="setRaw(true)"
              />
            </UFieldGroup>
          </div>

          <div v-if="rawMode" class="flex">
            <span class="code-gutter">
              <span v-for="n in numbers(1, count(raw))" :key="n" class="block" :class="mark(n)">{{
                n
              }}</span>
            </span>
            <CodeArea v-model="raw" :rows="count(raw)" aria-label="Service file" />
          </div>

          <template v-else>
            <div class="code-lock">
              <span class="code-gutter" :class="mark(1)">1</span>
              <span>{{ SHARED_LINE }}</span>
            </div>
            <div class="flex">
              <span class="code-gutter">
                <span
                  v-for="n in numbers(at.shared!, count(draft.shared))"
                  :key="n"
                  class="block"
                  :class="mark(n)"
                  >{{ n }}</span
                >
              </span>
              <CodeArea
                v-model="draft.shared"
                :rows="rows(draft.shared, SHARED_EXAMPLE)"
                :placeholder="SHARED_EXAMPLE"
                aria-label="Shared code"
              />
            </div>

            <template v-for="f in SERVICE_FUNCTIONS" :key="f.name">
              <template v-if="draft.functions[f.name] !== undefined">
                <div class="code-lock">
                  <span class="code-gutter" :class="mark(at[f.name]! - 1)">{{
                    at[f.name]! - 1
                  }}</span>
                  <span class="shrink-0"
                    ><span class="font-semibold text-primary">{{ f.name }}</span
                    >() {</span
                  >
                  <span class="code-hint">{{ f.hint }}</span>
                  <UIcon
                    v-if="f.name === 'detect'"
                    name="i-ph-lock-duotone"
                    class="mx-1.5 size-4 shrink-0 text-dimmed"
                    title="Required"
                  />
                  <UButton
                    v-else
                    icon="i-ph-x"
                    size="xs"
                    square
                    variant="ghost"
                    :aria-label="`Remove ${f.name}`"
                    @click="drop(f.name)"
                  />
                </div>
                <div
                  v-if="f.name === 'check' || f.name === 'fix'"
                  class="flex bg-elevated pe-2 pb-1.5"
                >
                  <span class="code-gutter" />
                  <UInput
                    v-if="f.name === 'check'"
                    v-model="draft.why"
                    size="sm"
                    placeholder="Alert text when check fails: why it matters"
                    aria-label="Alert text"
                    class="flex-1 font-sans"
                  />
                  <UInput
                    v-else
                    v-model="draft.fixLabel"
                    size="sm"
                    placeholder="Button label, like Restart Docker"
                    aria-label="Fix button label"
                    class="flex-1 font-sans"
                  />
                </div>
                <div class="flex">
                  <span class="code-gutter">
                    <span
                      v-for="n in numbers(at[f.name]!, count(draft.functions[f.name]))"
                      :key="n"
                      class="block"
                      :class="mark(n)"
                      >{{ n }}</span
                    >
                  </span>
                  <CodeArea
                    v-model="draft.functions[f.name]"
                    :data-fn="f.name"
                    :rows="rows(draft.functions[f.name], f.example)"
                    :placeholder="f.example"
                    :aria-label="`${f.name} body`"
                    indent
                  />
                </div>
                <div class="code-lock">
                  <span
                    class="code-gutter"
                    :class="mark(at[f.name]! + count(draft.functions[f.name]))"
                    >{{ at[f.name]! + count(draft.functions[f.name]) }}</span
                  >
                  <span>}</span>
                </div>
              </template>
              <button v-else type="button" class="code-add" @click="add(f.name)">
                <span class="code-gutter" />
                <span class="shrink-0">+ {{ f.name }}()</span>
                <span class="code-hint">{{ f.hint }}</span>
              </button>
            </template>

            <div class="code-lock pe-3">
              <span class="code-gutter" :class="mark(at.end!)">{{ at.end }}</span>
              <span>"$@"</span>
              <span class="code-hint">LynxTerm calls functions through this</span>
            </div>
          </template>

          <div
            class="flex flex-col gap-1 border-t border-accented bg-sunken px-3 py-2 font-sans"
            role="status"
          >
            <p
              class="flex items-center gap-2"
              :class="problem ? 'text-error' : syntax === null ? 'text-success' : 'text-dimmed'"
            >
              <template v-if="problem">
                <UIcon name="i-ph-x-circle-duotone" class="size-4 shrink-0" />
                <span
                  ><span v-if="problem.line" class="font-semibold">Line {{ problem.line }}: </span
                  >{{ problem.error }}</span
                >
              </template>
              <template v-else-if="syntax === null">
                <UIcon name="i-ph-check-circle-duotone" class="size-4 shrink-0" />
                Valid sh syntax
              </template>
              <template v-else>
                <UIcon name="i-ph-info-duotone" class="size-4 shrink-0" />
                {{ unavailable || "Checking syntax..." }}
              </template>
              <UButton
                v-if="fixable > 1"
                :label="`Fix ${fixable}`"
                icon="i-ph-magic-wand-duotone"
                size="xs"
                variant="outline"
                class="ml-auto"
                @click="setScript(fixServiceFile(script!))"
              />
            </p>
            <p
              v-for="w in warnings"
              :key="`${w.line} ${w.error}`"
              class="flex min-h-7 items-center gap-2 text-warning"
            >
              <UIcon name="i-ph-warning-duotone" class="size-4 shrink-0" />
              <span
                ><span class="font-semibold">Line {{ w.line }}: </span>{{ w.error }}</span
              >
              <UButton
                v-if="w.fixed !== undefined"
                label="Fix"
                size="xs"
                variant="ghost"
                class="ml-auto"
                :title="w.fixed.trim()"
                @click="setScript(applyFix(script!, w))"
              />
            </p>
          </div>
        </div>

        <div class="flex items-center justify-end gap-3">
          <span v-if="!draft.id && template" class="text-sm text-muted">
            The built-in stays as it is. Your copy is used on your hosts in its place.
          </span>
          <UButton
            color="primary"
            type="submit"
            :label="!draft.id && template ? 'Save as your own copy' : 'Save'"
          />
        </div>
      </form>

      <p class="hint">
        <UIcon name="i-ph-info-duotone" class="size-[18px]" />
        Function lines are locked: write bodies only, or edit everything in Raw file. Exit codes and
        output lines tell LynxTerm what happened.
      </p>
    </main>

    <EmptyLogo v-else />
  </div>
</template>
