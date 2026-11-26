// Moving a slow room to Relay over TCP: the suggestion card on the room screen, and the dialog that answers the
// other person's ask.
import { $ } from "../dom.ts";

export function wireSlowCard(controls: { switch(): void; dismiss(): void }): void {
  $("slow-switch").addEventListener("click", () => controls.switch());
  $("slow-dismiss").addEventListener("click", () => controls.dismiss());
}

export function showSlowCard(visible: boolean): void {
  $("slow-card").hidden = !visible;
}

/** Resolves true when the user accepts the other person's ask, false when they decline or the dialog is closed. */
export function askSwitch(): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("switch");
  dialog.returnValue = "";
  dialog.showModal();

  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "accept"), { once: true }),
  );
}

export function closeSwitch(): void {
  const dialog = $<HTMLDialogElement>("switch");
  if (dialog.open) dialog.close("decline");
}
