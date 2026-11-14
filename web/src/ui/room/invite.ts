// The creator's invite: link, QR code and the two keys, shown until the peer is in.
import type { Invite } from "../../crypto/invite.ts";
import { bindText } from "../../i18n/index.ts";
import { $ } from "../dom.ts";
import { burst } from "../motion.ts";
import { qrSvg } from "./qr.ts";

export function showInvite(invite: Invite, hideQr: boolean) {
  const link = invite.link(location.origin);
  $<HTMLInputElement>("invite").value = link;

  $("invite-qr").replaceChildren(qrSvg(link));
  $("qr-box").hidden = false;
  $("show-qr").hidden = false;
  setQr(!hideQr);

  $<HTMLInputElement>("show-access").value = invite.accessKey;
  $<HTMLInputElement>("show-secret").value = invite.fragment();
}

/** The peer is in or the room is over: the invite and its secret leave the page. Idempotent. */
export function clearInvite() {
  $("invite-box").hidden = true;
  $<HTMLInputElement>("invite").value = "";
  $<HTMLInputElement>("show-access").value = "";
  $<HTMLInputElement>("show-secret").value = "";
  $("invite-qr").replaceChildren();
}

function setQr(open: boolean) {
  $("qr-box").classList.toggle("is-open", open);
  $("show-qr").setAttribute("aria-expanded", String(open));
  bindText($("show-qr"), (m) => (open ? m.hideQr : m.showQr), ["aria-label", "title"]);
}

export function setupInvite() {
  $("show-qr").addEventListener("click", () => setQr(!$("qr-box").classList.contains("is-open")));
  $("copy").addEventListener("click", () => {
    void navigator.clipboard.writeText($<HTMLInputElement>("invite").value).then(
      () => {
        bindText($("copy"), (m) => m.copied);
        void burst($("copy"), "is-confetti");
      },
      () => $<HTMLInputElement>("invite").select(),
    );
  });
}
