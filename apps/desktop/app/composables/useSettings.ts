import { useLocalStorage } from "@vueuse/core";

// Per-device preferences in local storage, not vault: not secret, may differ per machine.
const defaults = {
  maskAddresses: false,
  /** Check GitHub for newer release at start and twice a day (useUpdates). */
  checkUpdates: true,
  history: true,
  /** Command blocks: hooks typed into each new session (SshTerminal). */
  blocks: true,
  /** Minutes between each sync section's turns (SYNC_SECTIONS). */
  syncEvery: { hosts: 5, snippets: 60, history: 1440, activity: 60 } as Record<string, number>,
  /** Saved host ids user stopped watching (isWatched). */
  unwatchedHosts: [] as string[],
  /** user@host:port where user turned 7-day history off. Every other watched server gets it
   *  set up once (ensureHistory). */
  noHistoryHosts: [] as string[],
  /** user@host:port where shell integration was installed or seen working. */
  integratedHosts: [] as string[],
  /** Alert rules (useAlerts), overrides by host id. `notify`: what alert does besides marking
   *  host card and logging activity. */
  monitoring: {
    rules: structuredClone(DEFAULT_RULES),
    overrides: {} as Record<string, Partial<Record<Metric, Rule>>>,
    notify: true,
    /** Minutes; 0 means until tomorrow morning. */
    snooze: 60,
  },
};

// Settings added in later versions, rules included, get their defaults.
const settings = useLocalStorage("lynxterm:settings", defaults, {
  mergeDefaults: (saved, d) => ({
    ...d,
    ...saved,
    monitoring: {
      ...d.monitoring,
      ...saved.monitoring,
      rules: { ...d.monitoring.rules, ...saved.monitoring?.rules },
    },
  }),
}).value;

export const useSettings = () => settings;

/** Watched: SSH login kept open for live readings. Default for key hosts; password hosts can't
 *  log in in background, so report only from a terminal. */
export const isWatched = (h: { id?: string; keyId?: string }) =>
  !!h.keyId && !settings.unwatchedHosts.includes(h.id!);
export function setWatched(h: { id?: string }, on: boolean) {
  const rest = settings.unwatchedHosts.filter((id) => id !== h.id);
  settings.unwatchedHosts = on ? rest : [...rest, h.id!];
}

/** maskAddresses on: 10.0.4.12 becomes 10.•.•.12, bastion.example.net becomes bastion.•.net. */
export function maskHost(host: string) {
  // Loopback reveals nothing; hiding it makes tunnels harder to read.
  if (!settings.maskAddresses || /^(127\.|::1$|localhost$)/.test(host)) return host;
  if (host.includes(":")) {
    const groups = host.split(":");
    return `${groups[0]}:…:${groups.at(-1)}`;
  }
  const parts = host.split(".");
  if (parts.length < 3) return host;
  return [parts[0], ...parts.slice(1, -1).map(() => "•"), parts.at(-1)].join(".");
}

export type View = "hosts" | "keychain" | "snippets" | "forwards" | "known" | "settings";

export const useView = () => useState<View>("view", () => "hosts");

type Section = "sync" | "groups" | "terminal" | "monitoring" | "privacy" | "about";
export const useSettingsSection = () => useState<Section>("settingsSection", () => "sync");

export function openSettings(section: Section) {
  useSettingsSection().value = section;
  useView().value = "settings";
}
