<script setup lang="ts">
// Enrolment token made here; user pastes it at Cloudflare's ENROLL_TOKEN prompt. Only first
// device needs it; later ones only URL. `password` skips master password field (first run).
const props = defineProps<{ password?: string }>();
const sync = useSync();

const form = reactive({ url: "", enrollToken: newEnrollToken(), password: "" });
const deployed = ref(false);

function deploy() {
  openExternal(DEPLOY_URL);
  deployed.value = true;
}
async function connect() {
  await sync.connect({ ...form, password: props.password || form.password });
  if (!sync.error.value) form.password = "";
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="connect">
    <ol class="flex flex-col gap-4">
      <li class="flex flex-col gap-2">
        <span class="text-sm"><span class="t-label mr-2">1</span>Copy this enrolment token</span>
        <UFieldGroup class="w-full">
          <UInput
            v-model="form.enrollToken"
            aria-label="Enrolment token"
            class="flex-1"
            :ui="{ base: 'font-mono text-xs' }"
          />
          <UButton
            label="Copy"
            color="neutral"
            variant="outline"
            @click="
              copyText(
                form.enrollToken,
                'Enrolment token copied',
                'Paste it as ENROLL_TOKEN on Cloudflare.',
              )
            "
          />
          <UButton
            icon="i-ph-arrows-clockwise"
            color="neutral"
            variant="outline"
            aria-label="New token"
            title="New token"
            @click="form.enrollToken = newEnrollToken()"
          />
        </UFieldGroup>
      </li>
      <li class="flex flex-col gap-2">
        <span class="text-sm">
          <span class="t-label mr-2">2</span>Deploy, and paste the token when Cloudflare asks for
          <span class="font-mono text-xs">ENROLL_TOKEN</span>
        </span>
        <UButton
          icon="i-ph-cloud-duotone"
          trailing-icon="i-ph-arrow-up-right"
          label="Deploy to Cloudflare"
          size="lg"
          block
          :variant="deployed ? 'outline' : 'solid'"
          :color="deployed ? 'neutral' : 'primary'"
          @click="deploy"
        />
        <div class="flex flex-wrap gap-1.5">
          <UBadge label="Worker lynxterm-vault" size="sm" class="font-mono" />
          <UBadge label="D1 lynxterm, bound as DB" size="sm" class="font-mono" />
          <UBadge label="free plan" size="sm" class="font-mono" />
        </div>
      </li>
      <li class="flex flex-col gap-2">
        <span class="text-sm"><span class="t-label mr-2">3</span>Paste the Worker's URL</span>
        <UInput
          v-model="form.url"
          placeholder="https://lynxterm-vault.you.workers.dev"
          required
          type="url"
          aria-label="Worker URL"
          class="w-full"
          :ui="{ base: 'font-mono text-xs' }"
        />
      </li>
    </ol>
    <UFormField v-if="!password" label="Master password">
      <UInput v-model="form.password" type="password" required class="w-full" />
    </UFormField>
    <UButton
      type="submit"
      label="Connect"
      size="lg"
      block
      :color="deployed ? 'primary' : 'neutral'"
      :variant="deployed ? 'solid' : 'outline'"
      :loading="sync.busy.value"
    />
    <UAlert
      v-if="sync.error.value"
      color="error"
      variant="subtle"
      icon="i-ph-warning-circle-duotone"
      :title="sync.error.value"
    />
  </form>
</template>
