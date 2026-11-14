# Technologies

The app is two browser pages and one small server. The browsers do all the cryptography and carry the
files directly between themselves. The server serves the page and relays sealed signalling frames. It is treated
as untrusted: it must never see the secret, the derived keys, file names, sizes or contents.

## Rust and axum

The server is one Rust binary, built with edition 2024, using axum 0.8 and tokio. The code is one role per file:

- `src/main.rs` builds the shared `App` state, the HTTP router and the shutdown signals.
- `src/config.rs` reads `ADDR`, the metrics settings and `ASSETS_DIR` from the environment.
- `src/assets.rs` builds the table of served files at startup: the embedded frontend, the optional assets folder,
  the stamps, slots and version.
- `src/http.rs` serves that table, the stamped asset caching and the security headers.
- `src/relay.rs` is the `/ws` WebSocket relay.
- `src/rooms.rs` is the room state, with no I/O.
- `src/ice.rs` builds the STUN and TURN server list.
- `src/metrics.rs` counts events and renders the metrics text.

axum gives the project a small async HTTP server with a WebSocket upgrade on top of tokio. The server's job is
intentionally narrow: a room is an access key mapped to two seats, each
seat holding a token and either a connected socket or an away deadline. A creator sends a `create` hello, a joiner
sends a `join` hello, and a page that lost its socket sends a `rejoin` hello with its seat token and role. A `leave`
text frame deletes the room. Every binary frame after the hello is relayed unchanged to the other seat.

The relay applies fixed limits. Frames over 64 KiB are refused. Each peer has a 256-frame outbound queue; when the
queue is full, frames are dropped, which breaks the sealed stream and ends that connection by design. The server pings
every 15 s and treats 40 s without any frame, pongs included, as a dead socket. A dead socket makes its seat away for
the room's keep-alive instead of deleting the room, unless the keep-alive is Off. Rooms live in memory only, so the
process exits at once on `SIGTERM` or `SIGINT`; there is nothing to drain.

The public router serves `GET /` and `GET /r/{accessKey}` as the same page, `GET /ws` for signalling and a fallback
that serves embedded files. Every response gets a Content Security Policy (`default-src 'self'`, no inline scripts,
`frame-ancestors 'none'`), `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. The server writes no
logs and has no access to the secret, which travels only in the link fragment.

## rust-embed

`src/assets.rs` embeds the built frontend with `#[derive(RustEmbed)]` over `web/dist/`. `build.rs` builds `web/dist`
before the Rust compile: it runs `npm ci` when `web/node_modules` is absent and then `npm run build`. The `Dockerfile`
builds the frontend in its Node stage and sets `E2FT_WEB_PREBUILT=1`, so the Rust stage skips npm and embeds the
already built directory.

This gives one deployable binary that needs no asset directory at runtime. At startup the server copies the
embedded set into an in-memory table, lays the optional `ASSETS_DIR` folder over it and renders `index.html` and
`app.js` once. A request outside the explicit routes reads a path from that table and returns it with a MIME type
guessed by `mime-guess`. A missing path is 404.

Asset caching is content addressed. At startup `src/assets.rs` writes `?v=<first 12 hex chars of SHA-256>` onto every
local `src` and `href` in `index.html`, and onto the two lazy script URLs inside `app.js`. `src/http.rs` serves a URL
whose stamp matches the served file as `public, max-age=31536000, immutable`; any other URL, including an old page
with a stale stamp, gets `no-cache`. A browser or proxy therefore cannot pair a new page with an old script or
stylesheet.

The optional `ASSETS_DIR` folder is a runtime skin, read once at startup, so one image serves every deployment. Its
`public/` files are served over the built-in ones, and its `slots/<name>.html` replace the default text between
`<!-- slot:<name> -->` markers in `index.html` before the stamps are written, so the stamps follow the folder's
bytes. Without the folder the neutral page and styles stay. The folder is styling and page markup only.

## TypeScript and esbuild

The frontend is TypeScript under `web/src/` with no UI framework. Modules are grouped by role: `crypto/` for the
security core, `net/` for signalling and WebRTC, `transfer/` for files, `room/` for one room's lifecycle, and `ui/`
for all DOM code. A class owns state and a lifecycle; pure helpers stay exported functions. The page is plain DOM,
which keeps the bundle small and avoids a framework runtime.

`web/scripts/build.mjs` runs three esbuild builds in parallel, with `bundle`, `minify`, `format: "esm"` and targets
`chrome120`, `firefox120` and `safari17`:

- `src/main.ts` becomes `dist/app.js`.
- `node_modules/jsqr/dist/jsQR.js` becomes `dist/jsqr.js`.
- `src/crypto/ristretto.ts` becomes `dist/ristretto.js`.

`/jsqr.js` and `/ristretto.js` are marked external in the main build and loaded with `import()` only when needed, so
the initial bundle carries neither the QR decoder nor the curve math. `src/i18n/` holds one dictionary per UI language.
`web/public/` holds the HTML page, `sw.js`, `theme.js`, the stylesheets and the neutral theme tokens. `tsc --noEmit`
type-checks the source. Node 24 runs the unit tests directly with `--experimental-transform-types`, so there is no
test transpiler.

## WebRTC DataChannels

Files go from browser to browser over WebRTC. The creator of the pair makes the offer, and the joiner answers. SDP and
ICE candidates are not sent through a plain signalling channel: they are sealed with the room key and relayed over
`/ws` inside the same encrypted stream as the other peer messages, so the server cannot read or swap them.

Each side creates the same two negotiated, ordered and reliable data channels in `web/src/net/peer.ts`:

- `"share"`, id 0, carries only binary file chunks.
- `"ctl"`, id 1, carries only sealed control messages as base64url text.

Splitting them means an acknowledgement never waits behind a backlog of file chunks. Control has its own receive
chain, and all chunks from all connections share another chain, so a slow disk write never delays an ack.

One connection is not enough for speed. DataChannels on one `RTCPeerConnection` share one congestion window, and
Firefox's SCTP stack caps a single connection far below a fast link. The sender therefore opens extra
`RTCPeerConnection`s, called lanes, per transfer (`web/src/net/lane.ts`). Each lane has one negotiated binary channel
named `"lane"`. Lane 0 is the room's `"share"` channel.

The sender grows lanes while they help (`web/src/transfer/outgoing.ts`, `web/src/transfer/lanes.ts`). Three seconds
after sending starts it opens lane 1. Every further three seconds it measures the bytes that left all send buffers,
not the acks, which lag behind lane 0's backlog. If the rate rose by 20 percent or more it opens another lane; if it
fell it closes the newest and stops. If the gain is less than 20 percent but the rate did not fall, the new lane stays
and growth stops. A lane that is not open within 10 s counts as failed. A lane whose channel closes
or whose ICE goes `disconnected` or `failed` is dropped, and its chunks that were not yet acknowledged are sent again
on the remaining lanes. Lane 0 failing is the room connection failing. Lanes close on `received`, on a cancel from
either side, on a failure and when the room connection drops.

The direct cap is 8 connections per direction, connection 0 included. A relayed pairing is bounded by the TURN
server's per-user allocation quota, which the app divides between the two sides and, when files go both ways, between
the two directions. `?lanes=N` (1 to 8) opens N connections at once and never adapts; it exists for measurements and
tests. Extra lanes carry their SDP and ICE as sealed `lane` and `lane-ice` control messages, so the server cannot tell
that lanes exist.

## CPace on ristretto255 via @noble/curves

The two people share only a short secret, 6 Crockford base32 characters or 30 bits. A 30-bit value used directly as a
key would fall to an offline search, so the secret is used as a password in CPace, a password-authenticated key
exchange (draft-irtf-cfrg-cpace-21). The exchange turns the secret into a 64-byte intermediate session key, and an
attacker gets one online guess per room, not an offline search.

`web/src/crypto/key-exchange.ts` runs the protocol on ristretto255 with SHA-512 in the initiator-responder setting.
The creator is A and the joiner is B. The password-related string is the 6 secret characters. The channel identifier
binds the run to the room: `lv_cat("e2ft/v1", accessKey)`. The session id is empty. The associated data are the role
names `creator` and `joiner`, so a relay that reflects one side's share or tag back to it fails. After the shares, each
side sends the draft's key-confirmation tag and checks the peer's tag. Only then is the session key released to the
room. A wrong tag or an invalid share ends the room on both sides with `Wrong secret key`. A pairing that ends before
this side's tag went out restarts the exchange with a fresh scalar on the next pairing; one that ends after the tag
went out ends the room, so a relay cannot cut runs short to test more than one guess.

A room started from the list of devices on the same network has no secret. It runs the same exchange with a fixed,
public password, so the exchange alone cannot tell the real peer from a relay in the middle. Two additions make it
safe. The creator first sends a SHA-512 commitment to its share and reveals the share only after the joiner sent its
own, so neither side's share can be chosen after seeing the other's. Both pages then derive 6 digits from the session
key with HKDF and show them, and signalling starts only after both people confirm the codes match. A relay in the
middle holds two different keys and gets one chance in a million per attempt. Such a run is never restarted once a
side sent its share, so a relay cannot collect fresh shares until the codes happen to match.

WebCrypto has SHA-512, HMAC, HKDF, AES-GCM and a random number generator, but it has no ristretto255 group
operations. The project therefore imports `@noble/curves` 2.4.0 for the group math only. It is the only JavaScript
crypto library the app imports. `web/src/crypto/cpace.ts` is a function-by-function transcription of the draft, and
its tests check the draft's ristretto255 test vectors. `web/src/crypto/ristretto.ts` re-exports the noble primitives,
esbuild builds it as `dist/ristretto.js`, and `web/src/net/signal.ts` loads it with `import()` when a room starts. The
page therefore stays free of curve code until it joins or creates a room. SHA-512, HMAC, randomness and all
key handling stay in WebCrypto.

## WebCrypto HKDF and AES-GCM

The 64-byte CPace session key is never a working key. `web/src/crypto/keys.ts` imports it as a non-extractable HKDF
key and derives room keys with HKDF-SHA256, salt `"e2ft/v1"`:

- The signalling key uses info `signal/<accessKey>` and is an AES-256-GCM key.
- A file key uses info `file/<accessKey>/<transferId>` and is an AES-256-GCM key, where `transferId` is a fresh random
  identifier per file.

All derived keys are non-extractable. The imported session key and the CPace intermediates are zeroed after WebCrypto
takes them, as a best effort.

Signalling and control messages use the `Sealer` in `web/src/crypto/sealer.ts`. The wire form is a 12-byte random IV
followed by AES-GCM of the JSON object `{s: sequence, m: message}`. The additional authenticated data is
`"<label>:<sender role>"`, with the label `sig/<generation>` for signalling and `ctl` for control. The receiver uses
the peer's role in the AAD, so the relay cannot reflect a peer's own message back to it, and a signalling frame cannot
be replayed as a control frame. A strict sequence number makes replay, reordering and drops fail. The first failure
poisons the stream and the page ends the session with `Connection failed: a signalling message did not verify. Someone
may have tampered with it.`

File chunks are encrypted with the per-file key. A plaintext chunk is a 64 KiB slice of the `File`. Its IV is four
zero bytes followed by the 64-bit big-endian chunk index, so a forged index fails authentication and any chunk is
valid on any connection. The frame on the data channel is `u32-be(transfer number) || u32-be(index) || ciphertext`.
A frame whose transfer number is not the current incoming transfer is dropped.

The sender reads a chunk at a time, never the whole file. It sends on the open connection with the least queued data,
pauses while that connection holds more than 8 MiB, and stays at most 1024 chunks, 64 MiB, ahead of the last
acknowledgement. The receiver decrypts each chunk on arrival, holds out-of-order chunks in a reorder buffer bounded
by the same 1024, writes them in order, refuses more bytes than were offered and closes the file when the byte count
equals the offered size. An error aborts the partial file.

## File System Access save picker

When the browser has `showSaveFilePicker`, the receiver saves through the File System Access API:
`web/src/transfer/picker-sink.ts`. The `Save File…` button opens the picker synchronously inside the click, because
the picker requires user activation, then calls `createWritable()`. Chunks are written to the writable as they arrive,
so the file goes to disk while the transfer runs. Cancelling a transfer aborts the writable, which discards the swap
file, and calls Chromium's `FileSystemFileHandle.remove()` on the created file where it exists.

This path is what Chromium-based desktop browsers use. It lets the user choose the folder and name and keeps memory
flat during a multi-gigabyte transfer.

## Service Worker streaming downloads

Where the browser has a controlling Service Worker and no save picker, the file is served as a streamed download
(`web/public/sw.js`, `web/src/transfer/sw-sink.ts`). `web/src/transfer/save.ts` registers `/sw.js` on page load. The
worker calls `clients.claim()` when it activates, so it controls the page at once. A page that is still uncontrolled
after `serviceWorker.ready`, for example after a hard reload, posts `{t:"claim"}` and the worker claims it.

For an accepted file the page posts `{t:"dl", id, name, size, port}` with a `MessagePort`, waits for `ready`, and then
loads `/dl/<id>` in a hidden iframe. The worker answers with a `Response` whose body is a `ReadableStream` with
`Content-Disposition: attachment` and `Content-Length`. The stream's `pull` asks the page for one chunk through the
port, with a high-water mark of 16 chunks, so memory stays bounded. Chunk buffers are transferred, not copied. The page
posts a message every 10 s so the worker is not stopped mid-download. An abort errors the stream. A cancel made in the
browser's own download list arrives as a `cancel` message and is treated as a receiver cancel.

This path is used in Firefox and Safari when a Service Worker controls the page. There the file appears in the
browser's download list and grows while it arrives.

## OPFS

The Origin Private File System is the last save path and the iOS hold path (`web/src/transfer/opfs-sink.ts`). The page
opens `navigator.storage.getDirectory()`, gets or creates the `incoming` directory, creates a file named by the
transfer id and writes chunks through `createWritable()`.

- When the browser has OPFS but neither a picker nor a controlling Service Worker, the file is written to OPFS and
  downloaded through an `<a download>` object URL after it closes.
- On iOS and iPadOS the file is written to OPFS but not downloaded. The history row gets a `Save` button that opens
  the share sheet with the file (`Save Image`, `Save to Files`) or falls back to an `<a download>`. The status asks the
  user to tap `Save` instead of saying it was saved.
- `opfsFits` checks `navigator.storage.estimate()` when the user accepts. If the file is larger than the free quota,
  the page asks `navigator.storage.persist()`, which can raise the quota, and checks again. If it still does not fit, the
  offer is declined and the message names the browser's storage limit, not the disk.
- Files in `incoming` older than one hour are deleted on a later page load, since a finished download may still be
  reading them.

A browser with no picker, no controlling Service Worker and no OPFS, such as some private windows, cannot save. The
offer is declined at once with a notice.

## STUN/TURN with coturn REST credentials

WebRTC needs STUN to discover a public address and TURN to relay when a direct path is impossible, for example
behind carrier-grade NAT. `src/ice.rs` builds the server list each time a room pairs. `STUN_URLS` is a
comma-separated list, empty for none, defaulting to a public STUN server. `TURN_URLS` is a comma-separated list,
empty for none. `TURN_SECRET` must be at least 32 characters.

TURN credentials follow coturn's REST scheme with `use-auth-secret`. The username is the expiry Unix time, 2 minutes
from now, with no user id. The credential is the standard base64 encoding of HMAC-SHA1 over that username with the
shared secret. Only a socket in a paired room receives them, within a per-client budget of 30 at once and one
every 5 seconds, and the secret itself never leaves the server. The
credential is time limited, so a leaked one is useless after its expiry. coturn checks the expiry only when an
allocation is created, so a browser asks for fresh credentials before it opens extra transfer connections.

The client can force its own side through TURN. `?relay=1`, the saved `Always use TURN` setting, or a custom room's
`Relay only` choice sets `iceTransportPolicy: "relay"` from the first configuration, so no host or server-reflexive
candidate is gathered or sent. `Relay only, over TCP` also rewrites every `turn:` URL to its `?transport=tcp` form.
`web/src/net/ice.ts` holds `relayConfig`, the URL checks and the parsing of the peer's untrusted `relay` message.

An own TURN server from Settings replaces every server-sent ICE server, STUN included. Its credential goes only into
the `RTCPeerConnection` configuration, never into a `/ws` frame and never into a shared-TURN frame in clear.

The client also detects an unreachable relay. `web/src/net/peer.ts` notes whether any local candidate was `relay`.
When gathering completes, or 10 s after it started, while the configuration holds a TURN URL but no relay candidate
came, it reports the relay as unreachable. A relay-only room ends at once with a message naming the relay by role; an
Auto room ends only if ICE fails before the channel opens. The Connection card reads the selected candidate pair from
`getStats()` and shows candidate types, protocol and round-trip time, never addresses.

## Prometheus text metrics

Metrics are off unless `METRICS=true`. When on, `src/main.rs` starts a second axum listener on `METRICS_ADDR`, default
`127.0.0.1:9090`, which serves only `GET /metrics`. The public router has no metrics route, so it returns 404 there.
`src/metrics.rs` renders Prometheus text format 0.0.4 by hand, with no client crate.

The output has gauges and counters: `e2ft_build_info{version}`, `e2ft_in_use`, `e2ft_rooms`, `e2ft_peers`,
`e2ft_away_seats`, `e2ft_rooms_created_total`, `e2ft_joins_total`, `e2ft_rejoins_total`,
`e2ft_errors_total{code}`, `e2ft_rooms_ended_total{cause}`, `e2ft_relayed_frames_total`,
`e2ft_relayed_bytes_total` and `e2ft_dropped_frames_total`.

Labels take only fixed values: an error code or a room-end cause. No access key, token, IP or per-room value ever
becomes a label. Gauges are read from the room state under its lock at scrape time. Counters live in process memory, so
a restart starts them at zero.

## Playwright e2e and the Node unit tests

Browser flows are tested with Playwright (`web/tests/e2e/`). Each spec covers one flow, and all specs share
`web/tests/e2e/fixtures.ts`, which launches separate Chromium and Firefox profiles against the real server, by default on
port 18080. The tests cover room creation and joining, settings and TURN choices, transfers in both directions, lane
growth and lane loss, cancel from either side, decline, reconnect and pause, the away countdown, room end, the QR code
and scanner, notifications, Fun mode and the save paths. Chromium's save picker is replaced in headless tests with an
OPFS file, Firefox downloads are checked through Playwright's download API, and camera tests use a fake video device
built from a single-frame `.y4m` file. The suite is the only practical way to exercise WebRTC, Service Workers, CSP
and the two-browser handshake together.

A second Playwright project, `web/tests/integration/` (`npm run integration`), runs the server with `TURN_URLS` and
`TURN_SECRET` against a real coturn on loopback that `web/scripts/coturn.sh start` brings up. It checks that both
browsers relay through coturn with the credentials the server signs and that a file arrives intact, and that a server
signing with a different secret never connects. With the same coturns running, `E2E_TURN=1` also runs the e2e specs
for user-entered TURN servers.

Logic that does not need a browser is tested with Node's built-in test runner:
`node --experimental-transform-types --test 'src/**/*.test.ts'`. Tests sit in a `__tests__/` folder beside their
module. They cover the CPace test vectors and key confirmation, invite parsing, seal round-trip, tamper, replay and
reflection, chunk index binding, the reorder buffer, lane caps, saved settings, storage fallbacks, translation
coverage and the version match between `Cargo.toml` and `web/package.json`.

`cargo test` covers the Rust side: room rules and statistics in `src/rooms.rs`, the asset table, stamps and slots in
`src/assets.rs`, stamped caching and legal-page routing in `src/http.rs`, the metrics text in `src/metrics.rs`, the TURN credential computation in `src/ice.rs`, and
the fixed hello key lengths in `src/relay.rs`.

## oxlint and oxfmt

`cd web && npm run check` is the frontend gate. It runs `tsc --noEmit`, `oxfmt --check`, `oxlint` with
`--deny-warnings --report-unused-disable-directives`, `web/scripts/check-style.mjs` and the Node unit tests.

`oxfmt` is the formatter, configured in `web/.oxfmtrc.json` with a width of 120. `oxlint` is the linter, configured
in `web/.oxlintrc.jsonc` with `oxlint-tsgolint` for type-aware rules. Correctness, suspicious and performance rules
are errors, warnings are denied, and every disabled rule is named with a reason. The linter checks explicit member
accessibility on classes and catches common async, promise and type mistakes.

`web/scripts/check-style.mjs` enforces two rules no linter covers: a `return` that follows other statements in its
block needs a blank line before it, and a file that declares a class declares exactly one, named after the file in
kebab case. The first keeps multi-step functions readable, the second keeps one class per file predictable.

## Browser support limits the code handles

The code checks capabilities rather than browser names where it can, and falls back in a fixed order. The save order
is `picker`, then `sw`, then `opfs`, with `hold` on iOS and iPadOS:

- `showSaveFilePicker` exists in Chromium-based desktop browsers. Firefox and Safari do not have it, so they use the
  Service Worker stream or OPFS.
- A controlling Service Worker requires a secure context and a registration that has activated. A hard reload or a
  page loaded before activation is controlled after the page posts `{t:"claim"}`.
- OPFS requires `navigator.storage.getDirectory()`, and the hold path also requires `createWritable` on
  `FileSystemFileHandle`. Private windows can lack both a worker and OPFS; the offer is then declined.
- iOS and iPadOS are detected by user agent and by a Mac user agent with touch points. There the page uses the hold
  path, offers `navigator.share` with files when `canShare` allows it, and does not start the go-home countdown while
  unsaved files are held. The page also warns that Safari suspends it when the user switches apps or locks the phone.
- `navigator.wakeLock` is optional. The room requests a screen wake lock while connected and ignores a refusal.
- The `Notification` API is absent in some iPhone tabs. The Settings field and the first-visit card are then hidden.
  Chrome on Android refuses `new Notification`, so the code prefers `ServiceWorkerRegistration.showNotification` and
  falls back to the page constructor.
- `BarcodeDetector` is used only when it supports `qr_code`. Otherwise the scanner lazily loads jsQR. The `Scan QR
  Code` button appears only on touch devices with `getUserMedia`, and the camera needs user permission.
- Browsers need WebCrypto for HKDF, AES-GCM, SHA-512 and HMAC. They do not provide ristretto255, which is why the
  noble chunk exists.
- Firefox reports the selected ICE candidate pair with a `selected` flag instead of `selectedCandidatePairId`; the
  Connection card handles both.
- `beforeunload` covers Firefox, which closes page sockets before a same-tab navigation, and `pagehide` covers the
  rest, except a page going into the back/forward cache.
- `history.replaceState` removes the invite fragment from the address bar and history before the Join screen appears.
- `navigator.storage.estimate` and `navigator.storage.persist` are used when OPFS is the save path; Firefox may show
  a permission prompt for persistent storage.
- `Intl.NumberFormat` unit formatting localizes file sizes, and `<dialog>`, `<progress>` and `<details>` provide the
  dialogs, progress bars and the keys disclosure without a framework.
