import { invoke } from "@tauri-apps/api/core";

// Commands per host (user@host:port), oldest first. Recorded and suggested only while setting
// on; stored encrypted in vault, so syncs.
const byHost = reactive(new Map<string, string[]>());
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function load() {
  // Loaded even when off so Settings can show and purge earlier history.
  byHost.clear();
  const items = await invoke<{ hostKey: string; commands: string[] }[]>("history_list");
  for (const { hostKey, commands } of items) {
    // Sync conflict can leave two items per host: merge.
    byHost.set(hostKey, [...(byHost.get(hostKey) ?? []), ...commands]);
  }
}

function record(hostKey: string, command: string) {
  // Leading space skips history, like bash HISTCONTROL=ignorespace.
  if (!useSettings().history || command.startsWith(" ") || command.includes("\n")) return;
  command = command.trimEnd();
  if (!command) return;
  const list = (byHost.get(hostKey) ?? []).filter((c) => c !== command);
  list.push(command);
  byHost.set(hostKey, list.slice(-500));
  // Debounce vault saves per host.
  clearTimeout(saveTimers.get(hostKey));
  saveTimers.set(
    hostKey,
    setTimeout(() => invoke("history_save", { hostKey, commands: byHost.get(hostKey) }), 3000),
  );
}

/** Best first: host history (newest first), snippets, then server PATH commands (shortest
 *  first). */
function suggest(hostKey: string, line: string, commands: string[], max = 6) {
  if (line.trim().length < 2) return [];
  const fits = (c: string) => c.startsWith(line) && c !== line;
  const history = (useSettings().history && byHost.get(hostKey)) || [];
  const snippets = useSnippets()
    .snippets.value.map((s) => s.command)
    .filter((c) => !c.includes("\n"));
  const path = line.includes(" ") ? [] : commands.filter(fits).sort((a, b) => a.length - b.length);
  const all = [...history.toReversed().filter(fits), ...snippets.filter(fits), ...path];
  return [...new Set(all)].slice(0, max);
}

/** One host's history, or all. Syncs to every device. */
async function purge(hostKey?: string) {
  for (const key of hostKey ? [hostKey] : [...byHost.keys()]) {
    clearTimeout(saveTimers.get(key)); // pending save would restore it
    byHost.delete(key);
  }
  await invoke("history_clear", { hostKey });
}

/** Hosts that ran this exact command (history keeps each command once per host). */
const usedOn = (command: string) =>
  [...byHost.values()].filter((list) => list.includes(command.trimEnd())).length;

export const useHistory = () => ({ byHost, load, record, suggest, purge, usedOn });
