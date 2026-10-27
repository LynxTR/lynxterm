<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";

const props = defineProps<{ status: "none" | "locked" }>();
const emit = defineEmits<{ unlocked: [] }>();
const onboarding = useOnboarding();

type Screen = "welcome" | "create" | "code" | "join" | "unlock" | "recover";
const screen = ref<Screen>(props.status === "none" ? "welcome" : "unlock");
const step = computed(() =>
  screen.value === "welcome" ? 0 : ["create", "code"].includes(screen.value) ? 1 : undefined,
);
// Welcome screen has own heading.
const HEADINGS: Partial<Record<Screen, [string, string]>> = {
  create: [
    "Create your vault",
    "Everything Lynxterm stores is encrypted with a key derived from this password. It never leaves this machine.",
  ],
  code: [
    "Save your recovery code",
    "It is the only way back in if you forget your master password. Nobody can reset it for you, and this is the only time it is shown.",
  ],
  join: [
    "Join your vault",
    "Use the Worker URL and master password from your other device. Everything syncs down, encrypted, and is unlocked here.",
  ],
  recover: [
    "Recover your vault",
    "Your recovery code unlocks the vault once, then you pick a new master password.",
  ],
  unlock: ["Unlock your vault", "Your keys and hosts are encrypted at rest."],
};

const password = ref("");
const confirm = ref("");
const rememberDevice = ref(true);
const keychain = isMac
  ? "the macOS Keychain"
  : navigator.userAgent.includes("Windows")
    ? "Windows Credential Manager"
    : "your system keyring";
const remember = {
  label: "Remember on this device",
  description: `Keeps the vault key in ${keychain}, so Lynxterm opens without your master password while you're signed in to this computer. The password itself is never stored, and Lock vault removes the key.`,
};
const recoveryInput = ref("");
const recoveryCode = ref(""); // shown once, right after vault creation
const saved = ref(false);
const busy = ref(false);
const error = ref("");

// Rough meter: length counts most, then character variety.
const strength = computed(() => {
  const p = password.value;
  if (!p) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((r) => r.test(p)).length;
  return Math.min(4, Math.floor(p.length / 6) + (kinds > 2 ? 1 : 0));
});
const strengthText = ["", "Too short", "Weak", "Good", "Strong. A sentence beats symbols."];

async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
const go = (s: Screen) => ((error.value = ""), (screen.value = s));

const create = () =>
  run(async () => {
    if (password.value !== confirm.value) throw new Error("The passwords don't match");
    recoveryCode.value = await invoke<string>("vault_create", {
      password: password.value,
      rememberDevice: rememberDevice.value,
    });
    screen.value = "code";
  });

// Vault open once code saved; sync and hosts next, in SetupScreen.
function afterCode() {
  onboarding.start(password.value);
  password.value = confirm.value = recoveryCode.value = "";
  emit("unlocked");
}

const unlock = () =>
  run(async () => {
    await invoke("vault_unlock", {
      password: password.value,
      rememberDevice: rememberDevice.value,
    });
    emit("unlocked");
  });

const recover = () =>
  run(async () => {
    await invoke("vault_recover", { code: recoveryInput.value, newPassword: password.value });
    emit("unlocked");
    // Worker signed out every other device; each asks for new password.
    if (await invoke("sync_url"))
      useToast().add({
        title: "Your other devices were signed out",
        description: "Sign in on each one with the new master password to keep it syncing.",
        icon: "i-ph-sign-out-duotone",
        duration: 30_000,
      });
  });

const workerUrl = ref("");
const join = () =>
  run(async () => {
    await invoke("vault_join", {
      url: workerUrl.value,
      password: password.value,
      rememberDevice: rememberDevice.value,
    });
    emit("unlocked");
    useSync().remindNewDevices();
  });

function saveCode() {
  const text = `Lynxterm recovery code\n\n${recoveryCode.value}\n\nThe only way into your vault if you forget the master password.\n`;
  Object.assign(document.createElement("a"), {
    href: "data:text/plain," + encodeURIComponent(text),
    download: "lynxterm-recovery.txt",
  }).click();
}

const points = [
  {
    icon: "i-ph-lock-duotone",
    title: "Encrypted vault, no account",
    text: "One master password. Nothing leaves this machine in the clear, and nobody can reset it for you.",
  },
  {
    icon: "i-ph-cloud-duotone",
    title: "Sync on your own Cloudflare Worker",
    text: "One click deploys a Worker with a D1 database on your account. The free plan is plenty. It only ever sees ciphertext.",
  },
  {
    icon: "i-ph-chart-line-duotone",
    title: "Monitoring built in",
    text: "CPU, memory and disk for every host, live while you work, and 7 days of history if you want it.",
  },
];
</script>

<template>
  <OnboardingCard :step="step" :title="HEADINGS[screen]?.[0]" :text="HEADINGS[screen]?.[1]">
    <template v-if="screen === 'welcome'">
      <div class="flex flex-col gap-2.5">
        <img src="/logo.svg" alt="" class="size-14" />
        <h1 class="text-[26px] leading-8 font-semibold tracking-tight">Lynxterm</h1>
        <p class="text-[15px] leading-6 text-toned">
          An SSH client that is open source, free, and yours. Hosts, keys and snippets live in an
          encrypted vault on this machine; sync runs on infrastructure you own.
        </p>
      </div>
      <ul class="flex flex-col gap-3.5">
        <li v-for="p in points" :key="p.title" class="flex gap-3">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-default bg-elevated text-toned"
          >
            <UIcon :name="p.icon" class="size-4" />
          </span>
          <span class="flex flex-col gap-0.5">
            <span class="font-semibold">{{ p.title }}</span>
            <span class="text-xs text-muted">{{ p.text }}</span>
          </span>
        </li>
      </ul>
      <div class="flex flex-col gap-2.5 pt-1">
        <UButton label="Get started" size="lg" block @click="go('create')" />
        <div class="flex justify-between text-xs">
          <UButton
            label="Already have a vault? Join it from this device"
            color="neutral"
            variant="link"
            size="xs"
            class="px-0"
            @click="go('join')"
          />
          <UButton
            label="MIT licensed"
            trailing-icon="i-ph-arrow-up-right"
            color="neutral"
            variant="link"
            size="xs"
            class="px-0"
            @click="openExternal(WORKER_REPO.replace(/\/tree\/.*/, ''))"
          />
        </div>
      </div>
    </template>

    <form v-else-if="screen === 'create'" class="flex flex-col gap-5" @submit.prevent="create">
      <UFormField label="Master password" hint="10+ characters">
        <UInput
          v-model="password"
          type="password"
          required
          minlength="10"
          autofocus
          size="lg"
          class="w-full"
        />
        <div class="mt-2 grid grid-cols-4 gap-1" aria-hidden="true">
          <span
            v-for="i in 4"
            :key="i"
            class="h-1 rounded-full"
            :class="i <= strength ? 'bg-[var(--ui-text-muted)]' : 'bg-accented'"
          />
        </div>
        <p v-if="strength" class="mt-1.5 text-xs text-muted">{{ strengthText[strength] }}</p>
      </UFormField>
      <UFormField label="Confirm">
        <UInput v-model="confirm" type="password" required size="lg" class="w-full" />
      </UFormField>
      <UCheckbox v-model="rememberDevice" v-bind="remember" />
      <UButton type="submit" label="Create vault" size="lg" block :loading="busy" />
      <div class="flex justify-between">
        <UButton
          label="Back"
          color="neutral"
          variant="link"
          size="xs"
          class="px-0"
          @click="go('welcome')"
        />
        <UButton
          label="Join an existing vault instead"
          color="neutral"
          variant="link"
          size="xs"
          class="px-0"
          @click="go('join')"
        />
      </div>
    </form>

    <template v-else-if="screen === 'code'">
      <div class="flex flex-col gap-3 rounded-xl border border-accented bg-default p-4">
        <span class="t-label">Recovery code</span>
        <code class="font-mono text-base leading-7 tracking-[0.04em] break-all">{{
          recoveryCode
        }}</code>
        <div class="flex gap-2">
          <UButton
            label="Copy"
            size="sm"
            color="neutral"
            variant="outline"
            @click="copyText(recoveryCode, 'Recovery code copied')"
          />
          <UButton
            label="Save as file"
            size="sm"
            color="neutral"
            variant="outline"
            @click="saveCode"
          />
        </div>
      </div>
      <UCheckbox v-model="saved" label="I stored this code somewhere that is not this machine." />
      <UButton label="Continue" size="lg" block :disabled="!saved" @click="afterCode" />
    </template>

    <form v-else-if="screen === 'join'" class="flex flex-col gap-5" @submit.prevent="join">
      <UFormField label="Worker URL">
        <UInput
          v-model="workerUrl"
          placeholder="https://lynxterm-vault.you.workers.dev"
          required
          size="lg"
          class="w-full"
          :ui="{ base: 'font-mono text-xs' }"
        />
      </UFormField>
      <UFormField label="Master password">
        <UInput v-model="password" type="password" required size="lg" class="w-full" />
      </UFormField>
      <UCheckbox v-model="rememberDevice" v-bind="remember" />
      <UButton type="submit" label="Join" size="lg" block :loading="busy" />
      <UButton
        label="Back"
        color="neutral"
        variant="link"
        size="xs"
        class="self-start px-0"
        @click="go(props.status === 'none' ? 'welcome' : 'unlock')"
      />
    </form>

    <form v-else-if="screen === 'recover'" class="flex flex-col gap-5" @submit.prevent="recover">
      <UFormField label="Recovery code">
        <UInput
          v-model="recoveryInput"
          required
          size="lg"
          class="w-full"
          :ui="{ base: 'font-mono tracking-[0.04em]' }"
        />
      </UFormField>
      <UFormField label="New master password" hint="10+ characters">
        <UInput
          v-model="password"
          type="password"
          required
          minlength="10"
          size="lg"
          class="w-full"
        />
      </UFormField>
      <UButton type="submit" label="Recover" size="lg" block :loading="busy" />
      <UButton
        label="Back"
        color="neutral"
        variant="link"
        size="xs"
        class="self-start px-0"
        @click="go('unlock')"
      />
    </form>

    <form v-else class="flex flex-col gap-5" @submit.prevent="unlock">
      <UFormField label="Master password">
        <UInput v-model="password" type="password" required autofocus size="lg" class="w-full" />
      </UFormField>
      <UCheckbox v-model="rememberDevice" v-bind="remember" />
      <UButton type="submit" label="Unlock" size="lg" block :loading="busy" />
      <UButton
        label="Forgot it? Use your recovery code"
        color="neutral"
        variant="link"
        size="xs"
        class="self-start px-0"
        @click="go('recover')"
      />
    </form>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-ph-warning-circle-duotone"
      :title="error"
    />
  </OnboardingCard>
</template>
