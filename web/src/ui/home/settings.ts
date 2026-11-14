// One form for the saved defaults (header button), a one-off custom room and the Join screen.
import { Invite } from "../../crypto/invite.ts";
import type { InviteHints } from "../../crypto/invite.ts";
import { bindText } from "../../i18n/index.ts";
import type { Text } from "../../i18n/index.ts";
import { cleanName, loadDevice, saveDevice } from "../../net/device.ts";
import { KEEP_ALIVES, loadSettings, parseSettings, saveSettings } from "../../net/settings.ts";
import type { Connection } from "../../net/ice.ts";
import { RELAY_ONLY, Room } from "../../room/room.ts";
import { $ } from "../dom.ts";
import { isLively, setLively } from "../motion.ts";
import { enableNotify, isNotify, setNotify } from "../notify.ts";
import { setSpeedUnit, speedUnit } from "../speed-unit.ts";

/** The invite link, a scanned QR and the join form all open the Join screen. */
export type OpenJoin = (invite: Invite) => void;

/** Turns notifications on from a click or a tick, reflecting the result in Settings. */
export async function turnOnNotify(): Promise<boolean> {
  const on = await enableNotify();
  $<HTMLInputElement>("set-notify").checked = on;
  $("set-notify-blocked").hidden = on;

  return on;
}

type SettingsMode = "defaults" | "custom" | "join";

/** One table for the three modes: which settings belong on the dialog, its title and its submit label. */
const MODES: Record<
  SettingsMode,
  {
    title: Text;
    submit: Text;
    keep: boolean;
    qr: boolean;
    share: boolean;
    conn: boolean;
    calm: boolean;
    speed: boolean;
    notify: boolean;
    alwaysTurn: boolean;
    device: boolean;
  }
> = {
  defaults: {
    title: (m) => m.settings,
    submit: (m) => m.save,
    keep: true,
    qr: true,
    share: true,
    conn: false,
    calm: true,
    speed: true,
    notify: true,
    alwaysTurn: true,
    device: true,
  },
  custom: {
    title: (m) => m.customTitle,
    submit: (m) => m.create,
    keep: true,
    qr: true,
    share: true,
    conn: true,
    calm: false,
    speed: false,
    notify: false,
    alwaysTurn: false,
    device: false,
  },
  join: {
    title: (m) => m.joinRoomTitle,
    submit: (m) => m.joinButton,
    keep: false,
    qr: false,
    share: false,
    conn: false,
    calm: false,
    speed: false,
    notify: false,
    alwaysTurn: true,
    device: false,
  },
};

/** The muted "This room" lines: only the creator's settings that differ from the defaults, or the unknown line. */
function roomHintLines(hints: InviteHints | null): Text[] {
  if (!hints) return [(m) => m.roomHintUnknown];

  const lines: Text[] = [];
  if (hints.keepAlive !== 300)
    lines.push(hints.keepAlive ? (m) => m.roomHintKeepAlive(hints.keepAlive / 60) : (m) => m.roomHintKeepAliveOff);
  if (hints.connection !== "auto")
    lines.push(hints.connection === "tcp" ? (m) => m.roomHintRelayTcp : (m) => m.roomHintRelay);
  if (hints.shareTurn) lines.push((m) => m.roomHintShareTurn);

  return lines;
}

/** `deviceChanged` runs after the saved defaults changed this device's visibility or name. */
export function setupSettings(deviceChanged: () => void): OpenJoin {
  const dialog = $<HTMLDialogElement>("settings");
  const form = $<HTMLFormElement>("settings-form");
  const keep = $<HTMLSelectElement>("set-keep");
  const relay = $<HTMLSelectElement>("set-relay");
  const share = $<HTMLInputElement>("set-share");
  const qrSelect = $<HTMLSelectElement>("set-qr");
  const conn = $<HTMLSelectElement>("set-conn");
  const calm = $<HTMLInputElement>("set-calm");
  const speed = $<HTMLSelectElement>("set-speed");
  const notifyBox = $<HTMLInputElement>("set-notify");
  const visible = $<HTMLInputElement>("set-visible");
  const deviceName = $<HTMLInputElement>("set-name");
  const alwaysTurn = $<HTMLInputElement>("set-always-turn");
  const alwaysTurnLabel = $("set-always-turn-label");
  const alwaysTurnHint = $("set-always-turn-hint");
  const shared = $<HTMLSelectElement>("set-shared");
  const [urls, user, pass] = ["set-urls", "set-user", "set-pass"].map((id) => $<HTMLInputElement>(id));
  const submit = $("set-submit");
  const errorLine = $("set-error");

  for (const keepAlive of KEEP_ALIVES) {
    const option = new Option("", String(keepAlive));
    bindText(option, (m) => (keepAlive ? m.keepAliveMin(keepAlive / 60) : m.keepAliveOff));
    keep.add(option);
  }

  const sharedMine = $<HTMLOptionElement>("set-shared-mine");
  const sharedOurs = $<HTMLOptionElement>("set-shared-ours");
  const showTurn = () => {
    const own = relay.value === "own";
    $("set-turn").hidden = !own;
    sharedMine.hidden = !own;
    sharedOurs.hidden = own;
    if ((own && shared.value === "ours") || (!own && shared.value === "mine")) shared.value = own ? "mine" : "ours";
  };
  relay.addEventListener("change", showTurn);

  // Permission is asked for in the change handler, where the browser still sees a user gesture.
  notifyBox.addEventListener("change", () => {
    if (notifyBox.checked) void turnOnNotify();
    else {
      setNotify(false);
      $("set-notify-blocked").hidden = true;
    }
  });

  let mode: SettingsMode = "defaults";
  let target: Invite | null = null;

  // The name matters, and the server sees it, only while the device is visible.
  const showName = () => ($("set-name-field").hidden = !MODES[mode].device || !visible.checked);
  visible.addEventListener("change", showName);

  const showError = (on: boolean) => {
    errorLine.hidden = !on;
    if (on) bindText(errorLine, (m) => m.badTurn);
    for (const field of [urls, user, pass]) field.setAttribute("aria-invalid", String(on));
  };

  const open = (next: SettingsMode, joining: Invite | null = null) => {
    mode = next;
    target = joining;
    const spec = MODES[next];
    const settings = loadSettings();

    keep.value = String(settings.keepAlive);
    qrSelect.value = settings.hideQr ? "hide" : "show";
    relay.value = settings.turn ? "own" : "ours";
    urls.value = settings.turn?.urls.join(", ") ?? "";
    user.value = settings.turn?.username ?? "";
    pass.value = settings.turn?.credential ?? "";
    share.checked = settings.shareTurn;
    alwaysTurn.checked = settings.alwaysTurn;
    conn.value = "auto";
    const device = loadDevice();
    visible.checked = device.visible;
    deviceName.value = device.name;
    $("set-visible-field").hidden = !spec.device;
    showName();
    calm.checked = !isLively();
    speed.value = speedUnit();
    notifyBox.checked = isNotify();
    $("set-notify-blocked").hidden = true;
    shared.value = settings.turn ? "mine" : "ours";
    showTurn();
    showError(false);
    $("set-keep-field").hidden = !spec.keep;
    $("set-qr-field").hidden = !spec.qr;
    $("set-share-field").hidden = !spec.share;
    $("set-conn-field").hidden = !spec.conn;
    $("set-calm-field").hidden = !spec.calm;
    $("set-speed-field").hidden = !spec.speed;
    $("set-notify-field").hidden = !spec.notify || !("Notification" in window);
    $("set-always-turn-field").hidden = !spec.alwaysTurn;
    $("set-joiner").hidden = next !== "join";

    // The creator's non-default hints, and the joiner's shared-TURN answer when the invite announced one.
    const hints = next === "join" ? (joining?.hints ?? null) : null;
    const lines = next === "join" ? roomHintLines(hints) : [];
    $("set-room-list").replaceChildren(
      ...lines.map((text) => {
        const item = Object.assign(document.createElement("li"), { className: "ui-muted" });
        bindText(item, text);

        return item;
      }),
    );
    $("set-room").hidden = !lines.length;

    // Unknown hints show only the unknown line, without claiming what the creator set up.
    $("set-room-lead").hidden = !hints;
    const chooseShared = next === "join" && !!hints?.shareTurn;
    $("set-shared-field").hidden = !chooseShared;

    // An Auto room with no own TURN never asked: it used the shared server.
    if (chooseShared && !RELAY_ONLY && !settings.alwaysTurn && !settings.turn && hints.connection === "auto")
      shared.value = "theirs";

    bindText($("settings-title"), spec.title);
    bindText(submit, spec.submit);
    // The same checkbox is per-room on the Join screen and a saved default in the Settings dialog.
    bindText(alwaysTurnLabel, (m) => (next === "join" ? m.useTurn : m.alwaysTurn));
    bindText(alwaysTurnHint, (m) => (next === "join" ? m.useTurnHint : m.alwaysTurnHint));

    dialog.showModal();
  };

  $("settings-btn").addEventListener("click", () => open("defaults"));
  $("custom").addEventListener("click", () => open("custom"));

  form.addEventListener("submit", (event) => {
    if (event.submitter !== submit) return;

    const own = relay.value === "own";
    const turn = { urls: urls.value.split(/[\s,]+/).filter(Boolean), username: user.value, credential: pass.value };
    const settings = parseSettings({
      keepAlive: Number(keep.value),
      turn: own ? turn : null,
      hideQr: qrSelect.value === "hide",
      shareTurn: share.checked,
      alwaysTurn: alwaysTurn.checked,
    });
    if (own && !settings.turn) {
      event.preventDefault();
      showError(true);

      return;
    }

    if (mode === "join") {
      if (!target) return;
      const useShared = target.hints?.shareTurn ? shared.value === "theirs" : undefined;
      Room.start("joiner", target, settings, "auto", useShared);
    } else if (mode === "custom") {
      const connection = conn.value as Connection;
      Room.start("creator", Invite.create({ ...settings, connection }), settings, connection);
    } else {
      saveSettings(settings);
      saveDevice({ visible: visible.checked, name: cleanName(deviceName.value) ?? loadDevice().name });
      deviceChanged();
      // Only write the choice when the box changed, so saving other settings never pins the reduce-motion default.
      if (calm.checked === isLively()) setLively(!calm.checked);
      if (speed.value !== speedUnit()) setSpeedUnit(speed.value === "bit" ? "bit" : "byte");
    }
  });

  return (invite) => open("join", invite);
}
