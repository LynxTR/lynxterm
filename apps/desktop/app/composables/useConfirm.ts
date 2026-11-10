import ConfirmDialog, { type Ask } from "~/components/ConfirmDialog.vue";

const dialog = useOverlay().create(ConfirmDialog);

export async function askConfirm(ask: Ask) {
  dialog.close(false);
  return (await dialog.open(ask)) === true;
}
