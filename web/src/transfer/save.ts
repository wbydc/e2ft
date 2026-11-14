// Which way this browser saves an accepted file: the save picker, a Service Worker streamed
// download, an OPFS file downloaded when complete, or (iOS) an OPFS file held for the user to save from the history
// list. The writers are in sinks.ts; this module sets up the Service Worker and OPFS and hands out held files.
export type SaveMode = "picker" | "sw" | "opfs" | "hold";

/** iOS and iPadOS (every browser there is WebKit). A download from the hidden iframe never reaches Files there. */
export const isIOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

type SaveFilePicker = (opts: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
export const picker = () => (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

const OPFS_DIR = "incoming";
/** The folder incoming OPFS files live in. */
export const opfsDir = async (create = false) =>
  (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR, { create });
const STALE_MS = 60 * 60 * 1000;
let opfs = false;

/** Registers the Service Worker and probes OPFS; call once on page load. */
export async function setupSaving(): Promise<void> {
  void navigator.serviceWorker?.register("/sw.js").catch(() => {});
  // A hard reload, or a page loaded before the worker activated, stays uncontrolled: ask it to claim us.
  void navigator.serviceWorker?.ready.then((registration) => {
    if (!navigator.serviceWorker.controller) registration.active?.postMessage({ t: "claim" });
  });
  try {
    const dir = await opfsDir(true);
    opfs = "createWritable" in FileSystemFileHandle.prototype;
    // Finished files stay until a later visit, since their download may still be reading them; another tab's
    // live transfer keeps its file fresh, so only old files go.
    for await (const [name, handle] of (
      dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
    ).entries()) {
      if (
        handle.kind === "file" &&
        Date.now() - (await (handle as FileSystemFileHandle).getFile()).lastModified > STALE_MS
      ) {
        await dir.removeEntry(name).catch(() => {});
      }
    }
  } catch {
    opfs = false;
  }
}

export function saveMode(): SaveMode | null {
  if (picker()) return "picker";
  if (isIOS) return opfs ? "hold" : null;
  if (navigator.serviceWorker?.controller) return "sw";

  return opfs ? "opfs" : null;
}

const room = async () => {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();

  return quota - usage;
};

/** A file over the quota asks for persistent storage, which lifts it where granted; Firefox prompts for it, so call
 *  this only from the user's accept. */
export async function opfsFits(size: number): Promise<boolean> {
  if ((await room()) > size) return true;

  return (await navigator.storage.persist?.().catch(() => false)) && (await room()) > size;
}

/** A held file under its real name, disk-backed (not read into memory). */
export async function heldFile(file: string, name: string, type: string): Promise<File> {
  const dir = await opfsDir();

  return new File([await (await dir.getFileHandle(file)).getFile()], name, { type });
}

/** Must run inside the tap: the share sheet (Save Image, Save to Files) where available, else a download. */
export function saveHeld(file: File) {
  if (navigator.canShare?.({ files: [file] })) {
    void navigator.share({ files: [file] }).catch(() => {});

    return;
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(file);
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 60_000);
}
