import ConfirmDialog, { type Ask } from "~/components/ConfirmDialog.vue";

// One confirm dialog app-wide for irreversible deletes.
const dialog = useOverlay().create(ConfirmDialog);

/** true on confirm; false on cancel or Escape. Newer question cancels open one. */
export async function askConfirm(ask: Ask) {
  dialog.close(false);
  return (await dialog.open(ask)) === true;
}
