// This device as others on its network see it: whether it is visible at all, off by default, and
// its name. The name and label cross the server in clear, so the default name is random and says nothing.
import { load, save } from "../store.ts";

export type DeviceSettings = { visible: boolean; name: string };

/** The server refuses longer labels (src/discover/lobby.rs LABEL_MAX). */
export const NAME_MAX = 32;

const COLORS = [
  ["Amber", "Azure", "Coral", "Crimson", "Golden", "Indigo", "Ivory", "Jade"],
  ["Lilac", "Maroon", "Olive", "Pearl", "Rose", "Rust", "Sage", "Scarlet"],
  ["Silver", "Slate", "Tan", "Teal", "Umber", "Violet", "Copper", "Mint"],
].flat();
const ANIMALS = [
  ["Badger", "Bison", "Crane", "Dingo", "Falcon", "Finch", "Gecko", "Heron"],
  ["Ibis", "Koala", "Lemur", "Lynx", "Marten", "Moose", "Newt", "Otter"],
  ["Panda", "Puffin", "Quail", "Raven", "Seal", "Stoat", "Tapir", "Wren"],
].flat();

const pick = (list: string[]) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];

export const randomName = (): string => `${pick(COLORS)} ${pick(ANIMALS)}`;

/** A name as the server accepts it, and without format characters that could reorder the text around it: no control characters, trimmed, at most NAME_MAX chars; null when nothing is left. */
export function cleanName(text: unknown): string | null {
  if (typeof text !== "string") return null;

  // Code points, as the server counts them (chars).
  const name = Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim())
    .slice(0, NAME_MAX)
    .join("")
    .trim();

  return name || null;
}

const BROWSERS: [RegExp, string][] = [
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Edg\/|EdgA\/|EdgiOS\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];
// Android before Linux, since an Android user agent names both.
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

/** Browser and system from the user agent, e.g. "Firefox, Linux": brand names, so the same in every language. */
export function deviceLabel(userAgent: string): string {
  const find = (table: [RegExp, string][]) => table.find(([pattern]) => pattern.test(userAgent))?.[1];

  return [find(BROWSERS), find(SYSTEMS)].filter(Boolean).join(", ") || "Browser";
}

/** Saved data is untrusted: anything invalid falls back to hidden and a fresh random name. */
export function parseDevice(raw: unknown): DeviceSettings {
  const fields = (raw ?? {}) as Partial<Record<keyof DeviceSettings, unknown>>;

  return { visible: fields.visible === true, name: cleanName(fields.name) ?? randomName() };
}

export function loadDevice(): DeviceSettings {
  try {
    return parseDevice(JSON.parse(load("device") ?? "null"));
  } catch {
    return parseDevice(null);
  }
}

export function saveDevice(device: DeviceSettings) {
  save("device", JSON.stringify(device));
}
