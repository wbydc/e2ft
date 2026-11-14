// The compare dialog of a discovered room: both screens show 6 digits, and the room goes on only when
// both people say they are the same. Closing it any other way counts as "no match".
import { $ } from "../dom.ts";

export function askCompare(code: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("compare");
  $("compare-code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  dialog.returnValue = "";
  dialog.showModal();

  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "match"), { once: true }),
  );
}

/** The room ended while the code was on screen. */
export function closeCompare(): void {
  const dialog = $<HTMLDialogElement>("compare");
  if (dialog.open) dialog.close("ended");
}
