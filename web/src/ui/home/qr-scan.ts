// Reads QR codes from the rear camera, all in the browser: BarcodeDetector where the browser has it,
// otherwise jsQR, loaded only now in its own chunk.

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare const BarcodeDetector:
  | { new (options: { formats: string[] }): BarcodeDetectorLike; getSupportedFormats(): Promise<string[]> }
  | undefined;

type Detect = (video: HTMLVideoElement) => Promise<string | null> | string | null;

async function detector(): Promise<Detect> {
  if (typeof BarcodeDetector !== "undefined" && (await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
    const barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });

    return async (v) => (await barcodeDetector.detect(v))[0]?.rawValue ?? null;
  }
  // A separate file loaded only here; the server adds its content hash to this URL (src/assets.rs).
  const url: string = "/jsqr.js";
  const { default: jsQR } = (await import(url)) as typeof import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true })!;

  return (video) => {
    // Decode at most 640 px wide: enough for a QR filling part of the frame, and fast on slow phones.
    const scale = Math.min(1, 640 / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (!width || !height) return null;

    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);

    return (
      jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: "dontInvert" })?.data ??
      null
    );
  };
}

/**
 * Shows the camera in `video` and hands each decoded QR text to `onCode` until it returns true. The camera stops
 * when this settles: on success, on `signal` abort (rejects with its reason) and on errors such as a denied camera.
 */
export async function scanQr(
  video: HTMLVideoElement,
  signal: AbortSignal,
  onCode: (text: string) => boolean,
): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    aborted.catch(() => {});

    video.srcObject = stream;
    await Promise.race([video.play(), aborted]);
    const detect = await Promise.race([detector(), aborted]);

    for (;;) {
      const text = await Promise.race([detect(video), aborted]);
      if (text && onCode(text)) return;
      await Promise.race([new Promise((r) => setTimeout(r, 150)), aborted]);
    }
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}
