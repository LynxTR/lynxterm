<script setup lang="ts">
defineProps<{ step?: number; title?: string; text?: string }>();
const steps = ["Welcome", "Vault", "Sync", "Hosts"].map((title) => ({ title }));
</script>

<template>
  <main
    class="flex min-h-screen flex-col bg-default bg-[radial-gradient(#1c2129_1px,transparent_1px)] bg-size-[22px_22px]"
  >
    <div
      data-tauri-drag-region
      class="flex h-10 shrink-0 items-stretch border-b border-default bg-sunken"
      :class="isMac && 'pl-[76px]'"
    >
      <span data-tauri-drag-region class="flex items-center px-3.5">
        <img src="/logo.svg" alt="Lynxterm" class="size-5" />
      </span>
      <div data-tauri-drag-region class="ml-auto flex items-stretch"><WindowControls /></div>
    </div>
    <div class="flex flex-1 flex-wrap items-center justify-center gap-6 overflow-y-auto px-4 py-10">
      <section
        class="flex w-full max-w-[540px] flex-col gap-6 rounded-2xl border border-default bg-muted px-10 pt-9 pb-8"
      >
        <UStepper
          v-if="step !== undefined"
          :items="steps"
          :model-value="step"
          size="xs"
          disabled
          class="w-full"
        />
        <div v-if="title" class="flex flex-col gap-1.5">
          <h1 class="t-title">{{ title }}</h1>
          <p class="text-sm text-toned">{{ text }}</p>
        </div>
        <slot />
      </section>
    </div>
  </main>
</template>
