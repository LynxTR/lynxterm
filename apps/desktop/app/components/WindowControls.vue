<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";

// macOS keeps native traffic lights (tauri.macos.conf.json).
const win = getCurrentWindow();
const buttons = [
  { label: "Minimize", icon: "i-ph-minus", onClick: () => win.minimize() },
  { label: "Maximize", icon: "i-ph-square", onClick: () => win.toggleMaximize() },
  { label: "Close", icon: "i-ph-x", onClick: () => win.close(), close: true },
];
</script>

<template>
  <div v-if="!isMac" class="flex items-stretch">
    <button
      v-for="b in buttons"
      :key="b.label"
      class="grid w-12 place-items-center text-muted transition-colors"
      :class="
        b.close ? 'hover:bg-[#c0392b] hover:text-white' : 'hover:bg-elevated hover:text-default'
      "
      :aria-label="b.label"
      :title="b.label"
      @click="b.onClick"
    >
      <UIcon :name="b.icon" class="size-3.5" />
    </button>
  </div>
</template>
