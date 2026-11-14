// The incoming-file dialog: accept picks where the file is written, anything else declines.
import { bindText, fmtBytes, translate } from "../../i18n/index.ts";
import type { Offer } from "../../transfer/wire.ts";
import { opfsFits, saveMode } from "../../transfer/save.ts";
import { OpfsSink } from "../../transfer/opfs-sink.ts";
import { PickerSink } from "../../transfer/picker-sink.ts";
import { SwSink } from "../../transfer/sw-sink.ts";
import type { Sink } from "../../transfer/sink.ts";
import { $ } from "../dom.ts";
import { burst } from "../motion.ts";
import { held } from "./history.ts";
import { notify } from "../notify.ts";
import { setStatus } from "../status.ts";

/** `cancel` stops the receive when a streamed download is cancelled in the browser. */
export async function askOffer(offer: Offer, cancel: () => void): Promise<Sink | null> {
  // The same id tags the offer's notification, so the transfer's end replaces it.
  void notify(
    translate((m) => m.offerTitle),
    translate((m) => m.notifyOfferBody(offer.name, fmtBytes(offer.size))),
    offer.id,
  );
  const mode = saveMode();
  if (!mode) {
    setStatus((m) => m.cantSave(offer.name), "warning");

    return null;
  }

  const dialog = $<HTMLDialogElement>("offer");
  const accept = $("offer-accept");
  $("offer-name").textContent = offer.name;
  bindText($("offer-size"), () => fmtBytes(offer.size));
  bindText(accept, (m) => (mode === "picker" ? m.saveFile : mode === "hold" ? m.receive : m.download));
  bindText($("offer-hint"), (m) => (mode === "picker" ? m.hintPicker : mode === "hold" ? m.hintHold : m.hintDownload));

  dialog.returnValue = "";
  dialog.showModal();
  void burst(dialog, "is-arrive"); // Fun mode: the offer slides in like a package.

  const declined = () => {
    if (dialog.returnValue !== "withdrawn") setStatus((m) => m.youDeclined(offer.name), "info");

    return null;
  };

  return new Promise<Sink | null>((resolve) => {
    const onAccept = () => {
      const sink =
        mode === "picker"
          ? PickerSink.open(offer.name)
          : mode === "sw"
            ? SwSink.open(offer.id, offer.name, offer.size, cancel).catch(async (error: unknown) => {
                if (!(await opfsFits(offer.size))) throw error;

                return OpfsSink.open(offer.name);
              })
            : openOpfs(offer, mode === "hold");

      dialog.close("accept");
      sink.then(resolve, () => resolve(declined()));
    };
    accept.addEventListener("click", onAccept, { once: true });
    dialog.addEventListener(
      "close",
      () => {
        accept.removeEventListener("click", onAccept);
        if (dialog.returnValue !== "accept") resolve(declined());
      },
      { once: true },
    );
  });
}

/** Runs inside the accept click, since `opfsFits` may ask for persistent storage; null when the file still does not
 *  fit. */
async function openOpfs(offer: Offer, hold: boolean): Promise<Sink | null> {
  if (!(await opfsFits(offer.size))) {
    setStatus((m) => m.noRoom(offer.name, fmtBytes(offer.size)), "warning");

    return null;
  }

  const sink = await OpfsSink.open(offer.name, hold);
  if (hold) held.set(offer.id, sink.file);

  return sink;
}

/** The sender withdrew the offer, or the connection went. */
export function closeOffer(why: "withdrawn" | "decline") {
  const dialog = $<HTMLDialogElement>("offer");
  if (dialog.open) dialog.close(why);
}
