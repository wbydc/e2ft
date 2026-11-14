// Streamed downloads for browsers without showSaveFilePicker. The page posts {t:"dl", id, name, size, port};
// GET /dl/<id> then answers with a stream that asks the page for one chunk per pull, so memory stays bounded.
const downloads = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// A clicked notification brings the e2ft tab forward, or opens one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => (clients.length ? clients[0].focus() : self.clients.openWindow("/"))),
  );
});

self.addEventListener("message", (e) => {
  const d = e.data;
  // An uncontrolled page (hard reload, or loaded before activation) asks to be claimed.
  if (d?.t === "claim") {
    e.waitUntil(self.clients.claim());
    return;
  }
  if (d?.t !== "dl") return;
  const { port } = d;
  const stream = new ReadableStream(
    {
      start(c) {
        port.onmessage = ({ data }) => {
          if (data === "done") c.close();
          else if (data === "abort") {
            downloads.delete(d.id);
            c.error(new Error("aborted"));
          } else c.enqueue(new Uint8Array(data));
        };
      },
      pull() {
        port.postMessage("pull");
      },
      cancel() {
        port.postMessage("cancel");
      },
    },
    { highWaterMark: 16 },
  );
  downloads.set(d.id, { stream, port, name: d.name, size: d.size });
  port.postMessage("ready");
});

const ascii = (s) => s.replace(/[^\x20-\x7e]|["\\/]/g, "_");

self.addEventListener("fetch", (e) => {
  const m = new URL(e.request.url).pathname.match(/^\/dl\/([A-Za-z0-9_-]{22})$/);
  const dl = m && downloads.get(m[1]);
  if (!dl) return;
  downloads.delete(m[1]);
  // The page waits for this before writing: a browser that sends /dl/ past the worker leaves it unsent.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort, which has no target origin
  dl.port.postMessage("fetched");
  e.respondWith(
    new Response(dl.stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(dl.size),
        "Content-Disposition": `attachment; filename="${ascii(dl.name)}"; filename*=UTF-8''${encodeURIComponent(dl.name)}`,
      },
    }),
  );
});
