<script setup lang="ts">
const { names, tags, ensure, setColor, rename, remove, move, renameTag, removeTag } = useGroups();
const { hosts } = useHosts();

const count = (group: string) => hosts.value.filter((h) => h.group === group).length;

const newName = ref("");
async function add() {
  await ensure(newName.value.trim());
  newName.value = "";
}

const editing = ref("");
const draft = reactive({ name: "", color: "" });
function startEdit(g: string) {
  editing.value = g;
  Object.assign(draft, { name: g, color: groupColor(g) });
}
async function saveEdit() {
  const from = editing.value;
  if (draft.color !== groupColor(from)) await setColor(from, draft.color);
  await rename(from, draft.name);
  editing.value = "";
}

async function forget(name: string) {
  const n = count(name);
  const ok = await askConfirm({
    title: `Delete group ${name}?`,
    description: n
      ? `${n} ${n === 1 ? "host keeps" : "hosts keep"} their settings and move to "No group".`
      : "No host is in it.",
  });
  if (ok) await remove(name);
}

const dragging = ref("");
const over = ref(-1);
function drop(to: number) {
  if (dragging.value) move(dragging.value, to);
  dragging.value = "";
  over.value = -1;
}

const { filter: tagFilter, shown: shownTags } = useFilter(
  () => tags.value,
  (t) => t.name,
);
const renamingTag = ref("");
const tagDraft = ref("");
async function saveTag() {
  await renameTag(renamingTag.value, tagDraft.value);
  renamingTag.value = "";
}
const mergeItems = (from: string) => [
  tags.value
    .filter((t) => t.name !== from)
    .map((t) => ({ label: t.name, onSelect: () => renameTag(from, t.name) })),
];
async function forgetTag(t: { name: string; hosts: number }) {
  const ok = await askConfirm({
    title: `Delete tag ${t.name}?`,
    description: `Takes it off ${t.hosts} ${t.hosts === 1 ? "host" : "hosts"}. The hosts stay.`,
  });
  if (ok) await removeTag(t.name);
}
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-7">
    <div class="flex flex-col gap-1">
      <h2 class="t-title">Groups and tags</h2>
      <p class="text-sm text-muted">
        A host belongs to one group and can carry any number of tags. Both filter the Hosts page and
        the ⌘K palette, and sync with your hosts.
      </p>
    </div>

    <section class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <h3 class="t-section">Groups</h3>
        <UBadge :label="String(names.length)" class="font-mono" />
        <span class="ml-auto text-xs text-muted">
          Drag to reorder: this is the order of the chips on Hosts
        </span>
      </div>
      <ul class="flex flex-col card">
        <li
          v-for="(g, i) in names"
          :key="g"
          class="flex min-h-12 flex-wrap items-center gap-3 border-t border-default px-3 py-2 first:border-t-0"
          :class="[
            editing === g && 'bg-elevated',
            over === i && dragging && dragging !== g && 'shadow-[inset_0_2px_0_var(--ui-primary)]',
            dragging === g && 'opacity-50',
          ]"
          @dragover.prevent="over = i"
          @dragleave="over === i && (over = -1)"
          @drop.prevent="drop(i)"
        >
          <span
            draggable="true"
            class="cursor-grab text-dimmed hover:text-muted"
            :aria-label="`Drag ${g}`"
            @dragstart="dragging = g"
            @dragend="((dragging = ''), (over = -1))"
          >
            <UIcon name="i-ph-dots-six-vertical" class="size-4" />
          </span>

          <form
            v-if="editing === g"
            class="flex min-w-0 flex-1 flex-wrap items-center gap-2.5"
            @submit.prevent="saveEdit"
          >
            <span
              class="size-3.5 shrink-0 rounded-full"
              :style="{ backgroundColor: draft.color || 'var(--ui-border-accented)' }"
            />
            <UInput
              v-model="draft.name"
              size="sm"
              required
              autofocus
              aria-label="Group name"
              class="min-w-40 flex-1"
            />
            <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
              <button
                v-for="c in GROUP_COLORS"
                :key="c.hex"
                type="button"
                role="radio"
                :aria-checked="draft.color === c.hex"
                class="size-6 rounded-full ring-offset-2 ring-offset-[var(--ui-bg)] transition-transform hover:scale-110"
                :class="draft.color === c.hex && 'ring-2 ring-[var(--ui-text)]'"
                :style="{ backgroundColor: c.hex }"
                :aria-label="c.name"
                :title="c.name"
                @click="draft.color = c.hex"
              />
            </div>
            <UButton type="submit" label="Save" size="sm" />
            <UButton
              label="Cancel"
              size="sm"
              color="neutral"
              variant="ghost"
              @click="editing = ''"
            />
          </form>
          <template v-else>
            <button
              class="size-3.5 shrink-0 rounded-full ring-offset-2 ring-offset-muted hover:ring-1 hover:ring-[var(--ui-border-accented)]"
              :style="{ backgroundColor: groupColor(g) || 'var(--ui-border-accented)' }"
              :aria-label="`Change color of ${g}`"
              @click="startEdit(g)"
            />
            <span class="min-w-0 flex-1 truncate font-medium">{{ g }}</span>
            <UBadge :label="`hosts ${count(g)}`" size="sm" class="font-mono" />
            <UButton
              label="Rename"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="startEdit(g)"
            />
            <UButton label="Delete" size="xs" color="neutral" variant="ghost" @click="forget(g)" />
          </template>
        </li>
        <li class="border-t border-default px-3 py-2" :class="!names.length && 'border-t-0'">
          <form class="flex items-center gap-2.5" @submit.prevent="add">
            <span class="size-3.5 shrink-0 rounded-full border border-dashed border-accented" />
            <UInput
              v-model="newName"
              placeholder="New group"
              aria-label="New group name"
              required
              size="sm"
              class="min-w-0 flex-1"
            />
            <UButton type="submit" label="Add group" size="sm" color="neutral" variant="outline" />
          </form>
        </li>
      </ul>
      <p class="text-xs text-muted">Deleting a group keeps its hosts; they move to "No group".</p>
    </section>

    <section class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <h3 class="t-section">Tags</h3>
        <UBadge :label="String(tags.length)" class="font-mono" />
        <UInput
          v-model="tagFilter"
          icon="i-ph-magnifying-glass-duotone"
          placeholder="Filter tags"
          aria-label="Filter tags"
          size="sm"
          class="ml-auto w-48"
        />
      </div>
      <ul v-if="shownTags.length" class="flex flex-col card">
        <li
          v-for="t in shownTags"
          :key="t.name"
          class="flex min-h-11 flex-wrap items-center gap-3 border-t border-default px-4 py-1.5 first:border-t-0"
        >
          <form
            v-if="renamingTag === t.name"
            class="flex min-w-0 flex-1 items-center gap-2"
            @submit.prevent="saveTag"
          >
            <UInput
              v-model="tagDraft"
              size="sm"
              required
              autofocus
              aria-label="Tag name"
              class="min-w-0 flex-1"
              :ui="{ base: 'font-mono' }"
            />
            <UButton type="submit" label="Save" size="sm" />
            <UButton
              label="Cancel"
              size="sm"
              color="neutral"
              variant="ghost"
              @click="renamingTag = ''"
            />
          </form>
          <template v-else>
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ t.name }}</span>
            <UBadge :label="`hosts ${t.hosts}`" size="sm" class="font-mono" />
            <UButton
              label="Rename"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="((renamingTag = t.name), (tagDraft = t.name))"
            />
            <UDropdownMenu :items="mergeItems(t.name)" :content="{ align: 'end' }">
              <UButton
                label="Merge into…"
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="tags.length < 2"
              />
            </UDropdownMenu>
            <UButton
              label="Delete"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="forgetTag(t)"
            />
          </template>
        </li>
      </ul>
      <p v-else class="text-sm text-muted">
        {{ tags.length ? "No tag matches." : "No tags yet." }}
      </p>
      <p class="text-xs text-muted">
        Add tags in the host editor: type one and press Enter. Tags are lowercase, with dashes for
        spaces. Merge moves every host from one tag to another.
      </p>
    </section>
  </div>
</template>
