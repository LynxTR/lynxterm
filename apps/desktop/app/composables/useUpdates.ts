import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

// No self-update: notice links to GitHub release page with each system's installer.

/** Numeric: "0.10.0" beats "0.9.2". Leading "v" and "-" pre-release suffix ignored. */
export function isNewer(latest: string, current: string) {
  // "1.2.0" equals "1.2".
  const plain = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .replace(/(\.0)+$/, "");
  return plain(latest).localeCompare(plain(current), "en", { numeric: true }) > 0;
}

type Download = { name: string; url: string; kind: string };
type Release = { version: string; url: string; download: Download | null };
// State made on first use: importing runs nothing (tests import).
export const useUpdates = () => ({
  current: useState("updateCurrent", () => ""),
  /** "Linux, x86_64": what download is for. */
  system: useState("updateSystem", () => ""),
  available: useState<Release | null>("updateAvailable", () => null),
  state: useState<"idle" | "checking" | "done" | "failed">("updateState", () => "idle"),
});
let notified = ""; // version already toasted this run

export async function checkForUpdate() {
  const { current, system, available, state } = useUpdates();
  state.value = "checking";
  try {
    current.value ||= await getVersion();
    const check = await invoke<{ system: string; latest: Release | null }>("latest_release");
    system.value = check.system;
    const latest = check.latest;
    available.value = latest && isNewer(latest.version, current.value) ? latest : null;
    state.value = "done";
  } catch {
    state.value = "failed";
    return;
  }
  const update = available.value;
  if (!update || notified === update.version) return;
  notified = update.version;
  const file = update.download;
  useToast().add({
    title: `Lynxterm ${update.version} is out`,
    description: file
      ? `You have ${current.value}. Download the ${file.kind} for ${system.value}.`
      : `You have ${current.value}. Get it from the release page.`,
    icon: "i-ph-arrow-circle-up-duotone",
    duration: 15_000,
    actions: [{ label: "Download", onClick: () => openExternal(file?.url ?? update.url) }],
  });
}

/** Version for Settings › About, then checks now and twice a day unless off there. */
export async function startUpdateChecks() {
  const settings = useSettings();
  // Fails only outside app (browser preview).
  useUpdates().current.value = await getVersion().catch(() => "");
  if (settings.checkUpdates) checkForUpdate();
  setInterval(() => settings.checkUpdates && checkForUpdate(), 12 * 3600 * 1000);
}
