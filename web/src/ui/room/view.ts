// The room screen as a whole: entering it, the send controls, the room info line, the shared-TURN question, and the
// ended state that counts down back home.
import type { Invite } from "../../crypto/invite.ts";
import type { Role } from "../../crypto/keys.ts";
import { bindText } from "../../i18n/index.ts";
import type { Connection } from "../../net/ice.ts";
import type { RelayBy } from "../../room/messages.ts";
import { isIOS } from "../../transfer/save.ts";
import type { Dir } from "../../transfer/events.ts";
import { $ } from "../dom.ts";
import { leaveLobby } from "../home/devices.ts";
import { burst } from "../motion.ts";
import { setStatus } from "../status.ts";
import type { Kind } from "../status.ts";
import { setConnInfo } from "./conn.ts";
import { held } from "./history.ts";
import { clearInvite, showInvite } from "./invite.ts";

/** What the room screen's controls ask the room to do. */
export interface RoomControls {
  send(file: File | undefined): void;
  cancel(dir: Dir): void;
  leave(): void;
}

/** Leaves home for the room screen; only the creator shows the invite, and a discovered room has none. */
export function showRoomScreen(role: Role, invite: Invite | null, hideQr: boolean): void {
  leaveLobby();
  $("home").hidden = true;
  $("room").hidden = false;
  void burst($("main"), "is-assemble");

  $("invite-box").hidden = role !== "creator" || !invite;
  $("ios-note").hidden = !isIOS;
  if (role === "creator" && invite) showInvite(invite, hideQr);
  $("room-info").hidden = true;
}

export function wireRoomControls(controls: RoomControls): void {
  $<HTMLInputElement>("file").addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    controls.send(input.files?.[0]);
    input.value = "";
  });

  const drop = $("drop");
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-over");
    controls.send(event.dataTransfer?.files[0]);
  });

  for (const dir of ["out", "in"] as const) $(`${dir}-cancel`).addEventListener("click", () => controls.cancel(dir));
  $("leave").addEventListener("click", () => controls.leave());
  // A fresh page clears the ended room's state; `?new` makes it create the next room right away.
  $("restart").addEventListener("click", () => location.assign("/?new"));
}

/** The file picker and the drop zone: off while disconnected or while a file is going out. */
export function setSendable(on: boolean): void {
  $<HTMLInputElement>("file").disabled = !on;
  $("drop").classList.toggle("is-disabled", !on);
}

/** A file starts going out: busy, not disconnected, so the room info and Connection Info stay on screen. */
export function showSending(): void {
  void burst($("drop"), "is-fire"); // Fun mode: the charged drop fires its sparks toward the sending bar.
  setSendable(false);
}

export function setConnected(on: boolean): void {
  setSendable(on);
  setConnInfo(on);
}

/** The peer is in: the drop area shows, and the invite and its secret no longer need to be on screen. */
export function showPaired(): void {
  clearInvite();
  $("drop").hidden = false;
  setStatus((m) => m.connected, "success");
  void burst($("main"), "is-pop");
}

export function hidePaired(): void {
  setConnected(false);
  $("drop").hidden = true;
}

/** The room's keep-alive (the creator's choice), which relay this browser uses and whether it must. */
export function showRoomInfo(keepAlive: number, relay: RelayBy, connection: Connection): void {
  const element = $("room-info");
  bindText(
    element,
    (m) => m.roomInfo(keepAlive / 60, relay) + { auto: "", relay: m.relayOnly, tcp: m.relayOnlyTcp }[connection],
  );
  element.hidden = false;
}

/** The joiner picks the creator's shared TURN or its own (`own`) or ours; closing the dialog means not theirs. */
export function askUseShared(own: boolean): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("turn-choice");
  bindText($("turn-mine"), own ? (m) => m.turnMine : (m) => m.turnOurs);
  dialog.returnValue = "";
  dialog.showModal();

  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "theirs"), { once: true }),
  );
}

/** The room ended: the screen says goodbye and offers a new room. */
export function showEnded(kind: Kind): void {
  // Only the user's own Leave ends with "info": it fades out calmly instead of booming like a lost room.
  void burst($("main"), kind === "info" ? "is-bye" : "is-boom");

  const dialog = $<HTMLDialogElement>("turn-choice");
  if (dialog.open) dialog.close("mine");

  clearInvite();
  $("leave").hidden = true;
  $("restart").hidden = false;
  backHome();
}

/** After the room ends, go home in 10 s; not with held files (iOS), since leaving the page drops any not yet saved. */
function backHome(): void {
  if (held.size) return;

  let left = 10;
  const tick = () => {
    if (left === 0) return location.assign("/");

    const seconds = left--;
    bindText($("restart"), (m) => m.restartIn(seconds));
  };
  tick();
  setInterval(tick, 1000);
}
