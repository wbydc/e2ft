import { $ } from "../dom.ts";
import { markNotifyAsked, shouldAskNotify } from "../notify.ts";
import { turnOnNotify } from "./settings.ts";

/** First home visit: the page itself offers notifications; either answer is remembered. */
export function setupNotifyCard() {
  const card = $("notify-card");
  if (!shouldAskNotify()) return;

  card.hidden = false;
  const answer = () => {
    markNotifyAsked();
    card.hidden = true;
  };
  $("notify-on").addEventListener("click", () => void turnOnNotify().then(answer));
  $("notify-no").addEventListener("click", answer);
}
