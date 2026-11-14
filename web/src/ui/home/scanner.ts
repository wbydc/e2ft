// Laptop-to-phone joining: decode the creator's invite QR with the camera. Only this origin's invites join.
import { Invite } from "../../crypto/invite.ts";
import { bindText } from "../../i18n/index.ts";
import type { Text } from "../../i18n/index.ts";
import { $ } from "../dom.ts";
import { scanQr } from "./qr-scan.ts";
import type { OpenJoin } from "./settings.ts";

export function setupScanner(openJoin: OpenJoin) {
  const button = $("scan");
  if (!(navigator.maxTouchPoints > 0 && navigator.mediaDevices?.getUserMedia)) return;

  button.hidden = false;
  const dialog = $<HTMLDialogElement>("scanner");
  const errorLine = $("scan-error");
  const showError = (text: Text | null) => {
    errorLine.hidden = !text;
    bindText(errorLine, text ?? (() => ""));
  };
  let scanning: AbortController | null = null;

  dialog.addEventListener("close", () => scanning?.abort());
  window.addEventListener("pagehide", () => scanning?.abort());
  button.addEventListener("click", () => {
    showError(null);
    dialog.showModal();

    const controller = (scanning = new AbortController());
    let invite: Invite | null = null;
    scanQr($<HTMLVideoElement>("scan-video"), controller.signal, (text) => {
      invite = Invite.parse(text, location.origin);
      if (!invite) showError((m) => m.notInvite);

      return !!invite;
    }).then(
      () => {
        dialog.close();
        if (invite) openJoin(invite);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        showError(
          error instanceof DOMException && error.name === "NotAllowedError" ? (m) => m.cameraDenied : (m) => m.noCamera,
        );
      },
    );
  });
}
