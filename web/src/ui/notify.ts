// Optional system notifications: off by default, saved in this browser only.
import { load, save } from "../store.ts";

const supported = () => "Notification" in window;

export const isNotify = () => supported() && Notification.permission === "granted" && load("notify") === "1";

export function setNotify(on: boolean) {
  save("notify", on ? "1" : "");
}

/** Asks the browser for permission from a user gesture; saves and returns whether notifications are on. */
export async function enableNotify(): Promise<boolean> {
  if (!supported()) return false;

  const granted = Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
  if (granted) setNotify(true);

  return granted;
}

/** Offers to ask on the first home visit, only while the browser has not decided yet. */
export function shouldAskNotify(): boolean {
  if (!supported() || Notification.permission !== "default") return false;

  return load("notifyAsked") !== "1";
}

export function markNotifyAsked() {
  save("notifyAsked", "1");
}

/** Shows a system notification only while the tab is hidden; `tag` lets a later one replace an earlier. */
export async function notify(title: string, body: string, tag: string): Promise<void> {
  if (!isNotify() || document.visibilityState !== "hidden") return;

  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href;
  const options = { body, tag, icon };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) await registration.showNotification(title, options);
    // oxlint-disable-next-line no-new -- a Notification shows itself when constructed
    else new Notification(title, options);
  } catch {
    // showNotification can reject (no active worker yet); fall back to the page-level constructor, which only
    // Chrome on Android refuses.
    try {
      // oxlint-disable-next-line no-new -- a Notification shows itself when constructed
      new Notification(title, options);
    } catch {}
  }
}
