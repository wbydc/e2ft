// Page wiring: home (create/join) -> room (invite, send, receive) -> ended.
import { ACCESS_LEN, Invite, SECRET_LEN } from "./crypto/invite.ts";
import { bindText, setupLang } from "./i18n/index.ts";
import type { Text } from "./i18n/index.ts";
import { loadSettings } from "./net/settings.ts";
import { Room } from "./room/room.ts";
import { setupSaving } from "./transfer/save.ts";
import { $ } from "./ui/dom.ts";
import { setupInvite } from "./ui/room/invite.ts";
import { setupScanner } from "./ui/home/scanner.ts";
import { setupDevices } from "./ui/home/devices.ts";
import { setupNotifyCard } from "./ui/home/notify-card.ts";
import { setupSettings } from "./ui/home/settings.ts";
import { setupTheme } from "./ui/theme.ts";

// The lengths are build-time settings; a fragment is the secret or 2 config chars and the secret.
const PASTED_LINK = new RegExp(`/r/([0-9A-Za-z]{${ACCESS_LEN}})#([0-9A-Za-z]{${SECRET_LEN},${SECRET_LEN + 2}})`);
const INVITE_PATH = new RegExp(`^/r/([0-9A-Za-z]{${ACCESS_LEN}})$`);

function fieldError(message: Text | null) {
  const errorLine = $("join-error");
  bindText(errorLine, message ?? (() => ""));
  errorLine.hidden = !message;

  for (const id of ["access", "secret"]) $(id).setAttribute("aria-invalid", String(!!message));
}

function init() {
  setupTheme($("theme"));
  setupLang($<HTMLSelectElement>("lang"));
  setupSaving();

  $("create").addEventListener("click", () => {
    const settings = loadSettings();
    Room.start("creator", Invite.create({ ...settings, connection: "auto" }), settings);
  });

  const openJoin = setupSettings(setupDevices);
  setupDevices();
  setupNotifyCard();
  setupScanner(openJoin);
  setupInvite();

  // A pasted full link fills both fields; Secret Key holds the whole fragment, so its hints come along.
  $("access").addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    const match = input.value.match(PASTED_LINK);
    if (!match) return;

    input.value = match[1];
    $<HTMLInputElement>("secret").value = match[2];
  });

  $("join").addEventListener("submit", (event) => {
    event.preventDefault();
    const typed = Invite.fromTyped($<HTMLInputElement>("access").value, $<HTMLInputElement>("secret").value);
    if (!typed) {
      fieldError((m) => m.badKeys);

      return;
    }

    fieldError(null);
    openJoin(typed);
  });

  const invite = location.pathname.match(INVITE_PATH);
  const hashKey = location.hash.slice(1);
  if (invite) {
    // Drop the secret from the address bar and history; a reload cannot rejoin anyway (the seat token is in memory).
    history.replaceState(null, "", "/");

    const parsed = Invite.parse(`${location.origin}/r/${invite[1]}#${hashKey}`, location.origin);
    if (parsed) openJoin(parsed);
    else $<HTMLInputElement>("access").value = invite[1];
  } else if (new URLSearchParams(location.search).has("new")) {
    history.replaceState(null, "", "/");
    $("create").click();
  }
}

init();
