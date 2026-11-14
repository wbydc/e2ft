// The home page's list of devices on this network: shown only while this device is visible. Tapping
// one asks it to start a room; the device that accepts creates the room and answers with its access key.
import { newAccessKey } from "../../crypto/invite.ts";
import { bindText } from "../../i18n/index.ts";
import type { Text } from "../../i18n/index.ts";
import { deviceLabel, loadDevice } from "../../net/device.ts";
import { Discover } from "../../net/discover.ts";
import type { Found } from "../../net/discover.ts";
import { loadSettings } from "../../net/settings.ts";
import { Room } from "../../room/room.ts";
import { $ } from "../dom.ts";

/** An ask nobody answers stops blocking the list after this long. */
const ASK_MS = 60_000;
/** After this page declines a device, its further asks are declined without a dialog for this long. */
const QUIET_MS = 30_000;

let discover: Discover | null = null;
/** The device we asked and its timeout; one ask at a time. */
let asking: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
/** The device whose ask is on screen. */
let askedBy: string | null = null;
/** We accepted and owe the asker our room's access key, so the socket outlives the home screen. */
let answering = false;
/** Devices this page declined, and when. */
const declined = new Map<string, number>();

function note(text: Text | null): void {
  const line = $("devices-note");
  bindText(line, text ?? (() => ""));
  line.hidden = !text;
}

function stopAsking(text: Text | null): void {
  clearTimeout(asking?.timer);
  asking = null;
  note(text);
  for (const button of $("devices").querySelectorAll("button")) button.disabled = false;
}

function ask(found: Found): void {
  if (asking || !discover) return;

  discover.ask(found.id);
  asking = { id: found.id, timer: setTimeout(() => stopAsking((m) => m.deviceNoAnswer(found.name)), ASK_MS) };
  note((m) => m.deviceAsking(found.name));
  for (const button of $("devices").querySelectorAll("button")) button.disabled = true;
}

function render(list: Found[]): void {
  $("devices").replaceChildren(
    ...list.map((found) => {
      const item = document.createElement("li");
      const button = Object.assign(document.createElement("button"), { type: "button", className: "ui-btn device" });
      const label = Object.assign(document.createElement("span"), { className: "ui-muted", textContent: found.device });
      button.append(Object.assign(document.createElement("span"), { textContent: found.name }), label);
      button.disabled = !!asking;
      button.addEventListener("click", () => ask(found));
      item.append(button);

      return item;
    }),
  );
  $("devices-empty").hidden = list.length > 0;

  const has = (id: string) => list.some((found) => found.id === id);
  if (asking && !has(asking.id)) stopAsking((m) => m.deviceGone);
  if (askedBy && !has(askedBy)) $<HTMLDialogElement>("ask").close("gone");
}

function asked(from: Found): void {
  const dialog = $<HTMLDialogElement>("ask");
  // Busy with another ask, either way, or declined it lately: decline, so the asker is not left waiting.
  const quiet = Date.now() - (declined.get(from.id) ?? -Infinity) < QUIET_MS;
  if (asking || askedBy || answering || quiet) return discover?.answer(from.id, null);

  askedBy = from.id;
  bindText($("ask-text"), (m) => m.askText(from.name, from.device));
  dialog.returnValue = "";
  dialog.showModal();
  dialog.addEventListener(
    "close",
    () => {
      askedBy = null;
      if (dialog.returnValue !== "accept") {
        declined.set(from.id, Date.now());

        return discover?.answer(from.id, null);
      }

      const accessKey = newAccessKey();
      answering = true;
      const done = () => {
        answering = false;
        leaveLobby();
      };
      Room.discovered("creator", accessKey, loadSettings(), {
        created: () => {
          discover?.answer(from.id, accessKey);
          done();
        },
        // The room ended before the server created it: nobody gets an answer, and the lobby closes now.
        ended: () => answering && done(),
      });
    },
    { once: true },
  );
}

function answered(from: string, room: string | null): void {
  if (asking?.id !== from) return;
  if (!room) return stopAsking((m) => m.deviceDeclined);

  stopAsking(null);
  Room.discovered("joiner", room, loadSettings());
}

/** Leaving home: the socket closes, so this device is no longer listed, unless an accepted ask still needs its answer. */
export function leaveLobby(): void {
  if (answering) return;

  clearTimeout(asking?.timer);
  asking = null;
  discover?.close();
  discover = null;
}

/** Opens or closes discovery to match the saved choice; called at start and after Settings saves. */
export function setupDevices(): void {
  const device = loadDevice();
  leaveLobby();
  $("devices-box").hidden = !device.visible;
  if (!device.visible) return;

  note(null);
  render([]);
  bindText($("devices-self"), (m) => m.deviceSelf(device.name));
  discover = new Discover(device.name, deviceLabel(navigator.userAgent), { devices: render, asked, answered });
}
