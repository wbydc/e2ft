// Every localStorage key this app uses. Storage can be blocked or full (private modes, quota); `load` then
// returns null and `save` does nothing. Each feature keeps its own parsing and defaults. public/theme.js reads
// `theme` and `calm` by their literal names before first paint, so keep them in step.
export const KEYS = {
  lang: "share-lang",
  theme: "wb-theme",
  calm: "share-calm",
  speedUnit: "share-speed-unit",
  notify: "share-notify",
  notifyAsked: "share-notify-asked",
  settings: "share-settings",
  device: "share-device",
} as const;

export type Key = keyof typeof KEYS;

export function load(key: Key): string | null {
  try {
    return localStorage.getItem(KEYS[key]);
  } catch {
    return null;
  }
}

export function save(key: Key, value: string) {
  try {
    localStorage.setItem(KEYS[key], value);
  } catch {}
}
