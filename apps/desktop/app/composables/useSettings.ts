import { useLocalStorage } from "@vueuse/core";

// Per-device preferences in local storage, not vault: not secret, may differ per machine.
const defaults = {
  maskAddresses: false,
  checkUpdates: true,
  history: true,
  localEcho: true,
  setupLine: true,
  syncEvery: { hosts: 5, snippets: 60, services: 60, history: 1440, activity: 60 } as Record<
    string,
    number
  >,
  unwatchedHosts: [] as string[],
  noHistoryHosts: [] as string[],
  integratedHosts: [] as string[],
  monitoring: {
    rules: structuredClone(DEFAULT_RULES),
    overrides: {} as Record<string, Partial<Record<Metric, Rule>>>,
    notify: true,
    snooze: 60,
  },
};

// Later-added settings, rules too, get defaults.
const settings = useLocalStorage("lynxterm:settings", defaults, {
  mergeDefaults: (saved, d) => {
    // Old `blocks: false`, `terminalStyle: "raw"` = no setup line. Keys dropped: migrate once.
    const { blocks, terminalStyle, ...rest } = saved as typeof saved & {
      blocks?: boolean;
      terminalStyle?: string;
    };
    return {
      ...d,
      ...rest,
      ...((blocks === false || terminalStyle === "raw") && { setupLine: false }),
      monitoring: {
        ...d.monitoring,
        ...rest.monitoring,
        rules: { ...d.monitoring.rules, ...rest.monitoring?.rules },
      },
    };
  },
}).value;

export const useSettings = () => settings;

/** Default for key hosts; password hosts can't
 *  log in in background, so report only from terminal. */
export const isWatched = (h: { id?: string; keyId?: string }) =>
  !!h.keyId && !settings.unwatchedHosts.includes(h.id!);
export const setWatched = (h: { id?: string }, on: boolean) => setIn("unwatchedHosts", h.id!, !on);

export function setIn(
  key: "unwatchedHosts" | "noHistoryHosts" | "integratedHosts",
  item: string,
  present: boolean,
) {
  const rest = settings[key].filter((x) => x !== item);
  settings[key] = present ? [...rest, item] : rest;
}

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

export type View =
  | "hosts"
  | "keychain"
  | "snippets"
  | "services"
  | "forwards"
  | "known"
  | "settings";

const view = ref<View>("hosts");
export const useView = () => view;

type Section = "sync" | "groups" | "terminal" | "monitoring" | "privacy" | "about";
export const useSettingsSection = () => useState<Section>("settingsSection", () => "sync");

export function openSettings(section: Section) {
  useSettingsSection().value = section;
  useView().value = "settings";
}
