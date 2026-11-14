// The status line and the Fun mode glyph beside it: the away countdown, waiting, the reconnect plug.
import { bindText } from "../i18n/index.ts";
import type { Text } from "../i18n/index.ts";
import { $ } from "./dom.ts";
import { burst, isLively } from "./motion.ts";

export type Kind = "info" | "success" | "warning" | "danger";
/** Fun mode glyphs beside the status: the peer is away (countdown), we are listening (waiting), we reconnect (plug). */
export type Presence = "countdown" | "waiting" | "plug" | null;

let awayTimer: ReturnType<typeof setInterval> | undefined;

/** The glyph currently shown, the countdown holding on while its defuse plays, and a token for the latest defuse. */
let shown: Presence = null;
let defusing = false;
let defuseRun = 0;

function applyPresence() {
  $("countdown").toggleAttribute("hidden", !(shown === "countdown" || defusing));
  $("waiting").toggleAttribute("hidden", shown !== "waiting");
  $("plug").toggleAttribute("hidden", shown !== "plug");
}

/** Fun mode: at most one glyph beside the status, never the countdown and the plug together. */
export function setPresence(which: Presence) {
  if (which === "countdown") {
    // A fresh away cancels a defuse still playing from an earlier return.
    defusing = false;
    defuseRun++;
    $("countdown").classList.remove("is-defused");
  }

  shown = isLively() ? which : null;
  applyPresence();
}

export function setStatus(text: Text, kind: Kind = "info", presence: Presence = null) {
  const line = $("status");
  bindText(line, text);
  line.className = `ui-alert ui-alert--${kind}`;
  setPresence(presence);
}

/** Fun mode: the peer is back while the countdown shows; it fades, then hides once the burst settles. */
export function defuseCountdown() {
  const run = ++defuseRun;
  defusing = true;
  applyPresence();

  void burst($("countdown"), "is-defused").then(() => {
    if (run !== defuseRun) return;
    defusing = false;
    applyPresence();
  });
}

/** The other side is away: count down to the room's deletion. In Fun mode big MM:SS digits run beside it. */
export function showAway(secs: number) {
  const until = Date.now() + secs * 1000;
  const clock = $("countdown");
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    const text = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;

    setStatus((m) => m.peerAway(text), "warning");
    setPresence("countdown");

    clock.textContent = text;
    clock.style.setProperty("--panic", String(Math.max(0, 10 - left) / 10));
    clock.classList.toggle("is-scared", left <= Math.min(30, secs / 2));
    if (left <= 10) void burst(clock, "is-tick");
  };

  tick();
  awayTimer = setInterval(tick, 1000);
}

/** Stops the away clock and any defuse; says whether the countdown was up, so a return can defuse it. */
export function stopAway(): boolean {
  clearInterval(awayTimer);
  const wasCountdown = shown === "countdown";
  defusing = false;

  return wasCountdown;
}
