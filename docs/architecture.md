# Architecture

e2ft is a two-person file transfer web app. One Rust server serves the frontend and relays encrypted signalling
frames between the two browsers of a room. The browsers exchange files directly over WebRTC. There are no accounts
and no stored files. The secret that turns an invite into a room key never leaves the two browsers.

The server is untrusted by design. It must never see the secret, the keys derived from it, file names, sizes or
contents. It does not log requests, access keys or IP addresses, and it keeps rooms in memory only.

## Parts

```
 creator browser                                          joiner browser
 +---------------+                                        +---------------+
 | Room          |                                        | Room          |
 | Signal -- Peer|                                        | Signal -- Peer|
 +-------+-------+                                        +-------+-------+
         |                                                        |
         |  wss /ws: sealed SDP, ICE and control messages         |
         +------------------>  e2ft server  <---------------------+
         |                    (relays bytes,                     |
         |                     reads no payload)                 |
         |                                                        |
         +=========== WebRTC DataChannels =========================+
              direct, or through a TURN relay (ciphertext only)
```

The server serves the page, accepts one WebSocket per browser for signalling, creates and remembers rooms, and hands
out ICE servers with short-lived TURN credentials. The browsers run a password-authenticated key exchange over that
relayed channel, then encrypt every signalling frame and file chunk.

### Server modules

One axum binary. Each file has one role.

| File | Role |
|---|---|
| `src/main.rs` | Builds the shared `App` state (rooms, peer id counter, ICE settings, metrics counters), the routers and the optional metrics listener, and handles SIGTERM and SIGINT. |
| `src/config.rs` | Reads `ADDR`, `METRICS`, `METRICS_ADDR`, `ASSETS_DIR`, `TRUSTED_PROXIES`, `ROOM_WAIT` and `ROOMS_PER_CLIENT` from the environment. |
| `src/assets.rs` | Builds the table of every served file at startup: the frontend embedded by `rust-embed`, the optional assets folder over it, the content stamps in `index.html` and `app.js`, the page slots and the version. |
| `src/http.rs` | Serves that table, the stamped asset cache rules, the optional legal pages, and the security headers. |
| `src/relay.rs` | The `/ws` endpoint: hello parsing and validation, the per-connection read and write loops, ping and idle timeouts, the per-client socket limit and per-socket byte rate, binary frame relay, leave and away handling, and the wait for a joiner. |
| `src/rooms.rs` | Pure room state: an access key maps to a creator seat and a joiner seat, each with a token and either a connected peer or an away-until time. Also the creation time, the room cap, the pairing counter and the statistics. |
| `src/sockets.rs` | Pure count of open sockets per client address (IPv6 by its /64), one count for `/ws` (16) and one for `/discover` (32); `rooms.rs` counts created rooms by the same address. |
| `src/bucket.rs` | The token bucket that limits how fast a socket may send: `/discover` frames of one type, `/ws` relayed bytes. |
| `src/lobby.rs` | Pure discovery state: the visible home pages grouped by a keyed hash of their network, the address rules that decide whether an address may form a group, the name bounds, and the rate for one frame type. |
| `src/discover.rs` | The `/discover` endpoint: finds the client address (socket peer, or `X-Forwarded-For` behind trusted proxies), enters the page into its group, announces the group on every change, and passes asks and answers inside one group; an answer reaches only a page whose ask is still open. Its pings and idle timeout are shorter than `/ws`'s, and a socket that sends `hello` or `ask` too fast is closed. |
| `src/ice.rs` | Builds the ICE server list from `STUN_URLS` and `TURN_URLS`, with TURN credentials. |
| `src/metrics.rs` | Counters, gauges and the Prometheus text for `GET /metrics`. |

### HTTP surface

| Route | Response |
|---|---|
| `GET /` | The embedded `index.html`. |
| `GET /r/{accessKey}` | The embedded `index.html`, so an invite link can be opened directly. |
| `GET /ws` | The signalling WebSocket. |
| `GET /terms`, `GET /privacy` | The legal pages, but only when the build embedded them; otherwise these paths fall through to the asset handler and return 404. With `?lang=<code>` a page named `<page>.<code>.html` is served when it exists; English is the fallback. |
| any other path | A file from `web/dist/`, embedded in the binary at compile time. |

Every response carries `Content-Security-Policy: default-src 'self'; img-src 'self' data:; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=31536000`, `Cross-Origin-Opener-Policy:
same-origin` and a `Permissions-Policy` that allows only the camera (the invite scanner) and the screen wake lock
(kept while sending) to the page itself and turns the other powerful features off. Assets get `Cache-Control: no-cache` unless the URL carries `?v=<hash>` matching
the first 12 hex characters of the file's SHA-256; such a URL gets `public, max-age=31536000, immutable`.

The public router never serves `/metrics`. When `METRICS=true`, a second listener on `METRICS_ADDR` serves only that
path. Rooms are memory-only, so the process exits at once on SIGTERM or SIGINT; there is nothing to drain.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ADDR` | `127.0.0.1:8080` | Listen address of the public server. |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs. Empty means no STUN. |
| `TURN_URLS` | empty | Comma-separated TURN URLs. Empty disables TURN. |
| `TURN_SECRET` | none | Shared secret for TURN credentials, at least 32 characters. Required when `TURN_URLS` is set. |
| `METRICS` | unset | `true` starts the metrics listener; `false` or unset leaves it off. |
| `METRICS_ADDR` | `127.0.0.1:9090` | Listen address of the metrics listener. |
| `ASSETS_DIR` | unset | A folder served over the built-in files (Assets folder below). |
| `TRUSTED_PROXIES` | empty | Comma-separated addresses or CIDR blocks of the reverse proxies in front of the server. Only discovery uses it (below). |

Discovery needs the client's public address. With `TRUSTED_PROXIES` empty, that is the socket's peer address. When
the peer is a trusted proxy, it is the rightmost `X-Forwarded-For` entry that is not itself a trusted proxy: every
entry to the right of it was written by a proxy the operator trusts, so a client cannot forge it. A chain with no
such entry, or with an entry that is not an address, names nobody, and that page sees no devices. The proxy itself
must replace or append `X-Forwarded-For` for every request it forwards; a proxy that passes a client's own header
through from an untrusted peer lets that client pick its group.

### Rooms and keep-alive

A room is an access key with two seats. The creator's first `create` hello makes the room; the joiner's `join` hello
takes the second seat, which can be taken only once. Each seat stores the token its browser sent, so a later socket
can prove it owns the seat.

A room has a keep-alive chosen by the creator: 0, 60, 300, 900 or 1800 seconds, default 300. It limits how long a
room may sit in memory while one side is away.

- A `leave` deletes the room at once.
- A socket that closes without a leave makes its seat away until `now + keepAlive`. The other side is told
  `peer-away` with the remaining seconds. A keep-alive of 0 deletes the room immediately instead.
- A rejoin with the seat's token takes the seat back, from an away seat or even from a socket the server still thinks
  is open; that older socket is closed. Every accepted join or rejoin increments the room's pairing number (`gen`).
- When an away seat's keep-alive runs out, the room is deleted and the other side is told `peer-left`.
- A room whose joiner seat is still empty `ROOM_WAIT` seconds after it was created (900 by default) is deleted, even
  while the creator is connected; the creator gets the `unjoined` error.
- The server holds at most 10 000 rooms; a `create` past that gets the `busy` error.
- One client address (an IPv6 address counts by its /64) may hold `ROOMS_PER_CLIENT` (16 by default) live rooms it created, and one IPv6 /48 256;
  a `create` past that gets the `too-many` error. A room counts until it ends, so one host cannot fill the server.
- A peer that no longer holds a seat cannot relay frames into the room or delete it.

The server pings every 15 seconds. A connection that sends nothing, pongs included, for 40 seconds is treated as
closed, and its seat goes away.

### Signalling relay

`/ws` accepts one text hello, then binary frames, ICE requests and a possible leave text frame.

- The hello is validated before a seat is taken. A bad hello that parses but names an unknown room, a taken joiner
  seat, a bad keep-alive or a wrong rejoin token gets an `error` frame followed by a close.
- A hello that does not parse, a second hello, a binary frame before the hello, or a text frame other than the exact
  leave frame `{"t":"leave"}` or ICE request `{"t":"ice"}` closes the socket.
- `{"t":"ice"}` gets fresh `iceServers` back while the other seat is connected, and nothing otherwise. It counts
  against the relay budget below.
- After the hello, every binary frame is forwarded unchanged to the other connected seat. The server does not parse
  the payload or the four-byte pairing prefix in front of it.
- If the other seat is away or empty, the frame is dropped. Each peer has a queue of 256 outbound frames; a full
  queue drops frames. A drop is visible to the clients as a broken sealed stream.
- Frames above 64 KiB are refused.
- One client address (an IPv6 address counts by its /64) may hold 16 open `/ws` sockets. The next one gets the
  `too-many` error and is closed before its hello. Behind a trusted proxy the address is the one discovery uses.
- Each socket may relay 256 KiB at once, then 16 KiB per second. Signalling needs far less; a socket past that gets
  the `rate` error and is closed.

### ICE and TURN credentials

When a room pairs, each peer receives `iceServers`:

- One STUN entry `{ "urls": [ ... ] }` when `STUN_URLS` is not empty.
- One TURN entry `{ "urls": [ ... ], "username": "<expiry>", "credential": "<hmac>" }` when `TURN_URLS` is set. The
  username is the Unix time 2 minutes ahead, as a decimal string. The credential is
  `base64(HMAC-SHA1(TURN_SECRET, username))`, the standard time-limited TURN credential scheme. Only a paired socket
  receives it, and each client (an IPv4 address or an IPv6 /64) gets 30 credentials at once, then one every
  5 seconds. A pairing costs two, charged to the peer whose join caused it. Over that budget the entry is left out
  and `/metrics` counts it in `e2ft_turn_withheld_total`.

coturn checks the expiry only when an allocation is created, so an open connection outlives it. Extra transfer
connections allocate anew: a relayed browser asks for fresh servers with `{"t":"ice"}` before opening them.

The browser may replace these servers with its own TURN server, or force relay-only transport. The server still
never learns a peer's own TURN credential. A creator may pass its TURN server to the joiner sealed end to end, and a
custom room's relay mode travels the same sealed way.

### Metrics

When enabled, `GET /metrics` returns Prometheus text format 0.0.4, written by hand. No room key, token, address or
per-room value appears in it.

| Metric | Type | Meaning |
|---|---|---|
| `e2ft_build_info{version}` | gauge | Always 1; the label is the compiled version. |
| `e2ft_in_use` | gauge | 1 while at least one room exists. |
| `e2ft_rooms` | gauge | Rooms in memory. |
| `e2ft_peers` | gauge | Seats with a connected socket. |
| `e2ft_away_seats` | gauge | Seats waiting out their keep-alive. |
| `e2ft_discoverable` | gauge | Home pages visible to their network. |
| `e2ft_rooms_created_total` | counter | Rooms created. |
| `e2ft_joins_total` | counter | Joiner seats taken. |
| `e2ft_rejoins_total` | counter | Seats taken back after a drop. |
| `e2ft_errors_total{code}` | counter | Refused sockets by code: `exists`, `not-found`, `full`, `busy`, `keep-alive`, `too-many`, `rate`. |
| `e2ft_rooms_ended_total{cause}` | counter | Rooms deleted by cause: `leave`, `closed`, `expired`, `unjoined`. |
| `e2ft_relayed_frames_total` | counter | Binary frames relayed. |
| `e2ft_relayed_bytes_total` | counter | Bytes of relayed frames. |
| `e2ft_dropped_frames_total` | counter | Frames dropped because the other peer's queue was full or closed. |

## Frontend modules

TypeScript bundled with esbuild. No framework. One module has one role; stateful things with a lifecycle are
classes, and pure helpers stay functions. All DOM code lives under `ui/`.

### Entry and storage

| File | Role |
|---|---|
| `web/src/main.ts` | Boots the home page: create, join form, invite links, QR scanner wiring. |
| `web/src/config.ts` | The build-time settings: the defaults, or the values the build injected. |
| `web/src/store.ts` | Names every `localStorage` key and wraps reads and writes; blocked storage reads as empty. |

### A room

| File | Role |
|---|---|
| `web/src/room/room.ts` | The `Room` class: one room from start to end, holding signalling, the peer connection of the current pairing, the room's `Transfers`, the wake lock and the page events that end, wake or reseat the room. |
| `web/src/room/messages.ts` | Text tables: server refusals, relay failure messages and notification titles. |

### Cryptography

| File | Role |
|---|---|
| `web/src/crypto/invite.ts` | The `Invite` class: access key, secret and room hints, parsed from a link or typed text and formatted back, plus the Crockford base32 codec. |
| `web/src/crypto/keys.ts` | Room key derivation with HKDF, per-transfer file keys, random tokens and base64url helpers. |
| `web/src/crypto/cpace.ts` | The CPace draft's math on ristretto255, with the draft's names. |
| `web/src/crypto/key-exchange.ts` | The `KeyExchange` class: one CPace run with key confirmation. |
| `web/src/crypto/ristretto.ts` | The lazy chunk that exports the ristretto255 group math from `@noble/curves`. |
| `web/src/crypto/sealer.ts` | The `Sealer` ordered AEAD stream for signalling and control messages, and the per-chunk AES-GCM helpers. |

The protocol details are in [protocol.md](protocol.md).

### Network

| File | Role |
|---|---|
| `web/src/net/signal.ts` | The `Signal` class: the `/ws` client, rejoin logic, CPace over the relay, and the sealed signalling stream per pairing. In a discovered room it also runs the commitment and holds the pairing until both sides confirmed the code. |
| `web/src/net/discover.ts` | The `Discover` class: the `/discover` client, which reads the device list, asks and answers, treats every frame as untrusted, and reconnects every 5 seconds after a drop. |
| `web/src/net/device.ts` | This device's discovery settings: visible or not, its name, the random name generator and the browser and system label. |
| `web/src/net/peer.ts` | The `Peer` class: connection 0's `RTCPeerConnection`, the `share` and `ctl` channels, SDP and ICE handling, route detection and the no-relay check. |
| `web/src/net/lane.ts` | The `Lane` class: one extra `RTCPeerConnection` carrying one binary channel. |
| `web/src/net/ice.ts` | Pure ICE helpers: `iceServers`, `relayConfig`, `parseRelay`, `isTurnUrl`. |
| `web/src/net/settings.ts` | Room settings: parse, load, save and TURN validation. |
| `web/src/net/no-relay-error.ts` | The `NoRelayError` class. |

### Transfers

| File | Role |
|---|---|
| `web/src/transfer/transfers.ts` | The `Transfers` class: one outgoing and one incoming transfer, control message dispatch, pause on a dropped connection, cancel and abort. |
| `web/src/transfer/outgoing.ts` | The `Outgoing` class: the chunk loop, backpressure, lane growth and resend. |
| `web/src/transfer/incoming.ts` | The `Incoming` class: open and verify chunks, reorder, write and acknowledge. |
| `web/src/transfer/wire.ts` | Control message types, the chunk frame format, `CHUNK_SIZE` and `WINDOW`. |
| `web/src/transfer/constants.ts` | The speed knobs: buffer limits, ack batching, lane growth, connection caps. |
| `web/src/transfer/lanes.ts` | Connection 0's `Link`, `laneCap`, `laneConfig` and lane counting. |
| `web/src/transfer/reorder.ts` | The bounded reorder buffer that restores file order. |
| `web/src/transfer/events.ts` | What `Transfers` reports to the page. |
| `web/src/transfer/sink.ts` | The `Sink` interface. |
| `web/src/transfer/picker-sink.ts` | Saves through the File System Access save picker. |
| `web/src/transfer/sw-sink.ts` | Saves through a Service Worker streamed download. |
| `web/src/transfer/opfs-sink.ts` | Saves into the origin private file system. |
| `web/src/transfer/save.ts` | Chooses a save path, sets up the Service Worker and OPFS, and exposes held iOS files. |

### Interface and languages

| File | Role |
|---|---|
| `web/src/i18n/index.ts` | Current UI language, translation lookup and language switching. |
| `web/src/i18n/en.ts` | English dictionary; its shape is the `Messages` type. |
| `web/src/i18n/ru.ts` | Russian dictionary. |
| `web/src/ui/dom.ts` | The `$` element lookup. |
| `web/src/ui/status.ts` | The status line and its presence glyphs. |
| `web/src/ui/motion.ts` | The optional animations. |
| `web/src/ui/theme.ts` | The Auto, Light and Dark theme button. |
| `web/src/ui/notify.ts` | Optional system notifications. |
| `web/src/ui/speed-unit.ts` | Transfer speed in bytes or bits per second. |
| `web/src/ui/home/settings.ts` | The settings, custom room and Join dialogs. |
| `web/src/ui/home/notify-card.ts` | The first-visit notifications card. |
| `web/src/ui/home/devices.ts` | The list of devices on this network, one ask at a time, the incoming ask dialog (a device declined once is declined without a dialog for 30 seconds), and starting a discovered room. |
| `web/src/ui/home/scanner.ts` | The invite scanner dialog. |
| `web/src/ui/home/qr-scan.ts` | Camera QR decoding. |
| `web/src/ui/room/invite.ts` | The creator's invite card. |
| `web/src/ui/room/qr.ts` | The invite QR code as an SVG. |
| `web/src/ui/room/conn.ts` | The connection information card. |
| `web/src/ui/room/progress.ts` | Progress rows. |
| `web/src/ui/room/history.ts` | Finished transfers. |
| `web/src/ui/room/offer.ts` | The incoming file dialog. |
| `web/src/ui/room/compare.ts` | The dialog that shows a discovered room's 6-digit code. |
| `web/src/ui/room/view.ts` | The room screen: entering it, send controls, room info and the ended state. |

Static files live in `web/public/`: `index.html`, `app.css`, `theme.js` (applies a saved theme before first paint),
`sw.js` (streamed downloads and notification clicks), and the neutral theme in `ui/tokens.css` and
`ui/components.css`. `web/scripts/` holds the build steps. `web/tests/e2e/` holds one Playwright spec per flow:
`room`, `transfer`, `reconnect`, `join`, `settings`, `fun`, `qr`, `notify`, `legal` and `discover`, over
`fixtures.ts`. `web/tests/integration/` holds the specs that need a real coturn, started by `web/scripts/coturn.sh`.

## Room lifecycle

The creator's page makes the access key, the secret and the room hints locally before it contacts the server. It
opens `/ws` and sends a `create` hello with a random 22-character seat token and the keep-alive. The server inserts
the room and replies `created`, which moves the status from creating to ready. The invite card is on screen from the
moment the room screen opens.

The joiner opens `/r/<accessKey>#<config><secret>`. For a valid invite the page reads the fragment, replaces the
address bar entry with `/`, and shows the Join screen. Nothing connects before the user presses Join. The page then opens `/ws`, sends a
`join` hello, and the server takes the joiner seat, increments the pairing number to 1, and replies to both sides:
`joined` to the joiner and `peer-joined` to the creator, each with `iceServers`, `gen` and `keepAlive`.

Both pages then run CPace over the relayed binary channel. The pairing event is held back from the room screen until
the exchange confirms. Only then do both pages build an `RTCPeerConnection` and open the two data channels, with the
creator sending the sealed offer. The session is usable when both channels are open.

```
creator                    server                    joiner
  create   ------------->  create room
  created  <-------------  (creator seat)
                                      join  <-------  join
  peer-joined (gen 1) <---  (joiner seat)  ------->  joined (gen 1)
  CPace share/tag  <-------- relay ---------->  CPace share/tag
  sealed offer     --------- relay ---------->  sealed answer
  DataChannels     <===== direct or TURN =====>  DataChannels
```

Every new pairing (a rejoin on either side) increments `gen`, drops the old peer connection and builds a new one.
The room keys are reused from page memory, so no new CPace run happens. `gen` labels the signalling stream, so
frames from an earlier pairing cannot be opened in the next one. A page also keeps the highest `gen` it has seen
and ends the room if the server sends one that is not higher, so a dishonest server cannot replay an earlier pairing.

A leave, any end of the session, a `beforeunload`, or a `pagehide` that is not a back/forward-cache restore sends
`{"t":"leave"}`. The server deletes the room and sends `peer-left` to the other side if it is connected; the room
cannot be joined again.

A socket that dies without a leave does not end the room, unless the keep-alive is 0. Its seat is away for the
keep-alive, and the other side shows a countdown. The page rejoins at once after a lost socket, then with backoff of 2, 4, 8 and 10 seconds, giving
up after 30 minutes. A page that becomes visible after more than a second hidden, with no data channel, rejoins on a
fresh socket, because a suspended page's socket can look open while it is dead. A data channel that closes or ICE
that fails after the channels opened triggers a rejoin 1.5 seconds later; ICE that fails before the channels open
ends the room.

### A discovered room

With "Visible to devices on my network" on, the home page also opens `/discover` and lists the other visible pages
behind the same public address. When one device asks and the other accepts, the accepting page creates an ordinary
room with a fresh access key and no invite, and sends the key back once the server said `created`. The asking page
joins it. Both pages leave the home screen and close `/discover`. The key exchange runs with a public password, the
creator's share committed first, and the room screen shows the compare dialog. The pairing event that starts WebRTC
reaches the room only after both sides tapped "It Matches". After that the room behaves like any other, except that
it never shows an invite. Wire details are in the protocol, "Discovered rooms" and "Discovery".

## A transfer end to end

1. The sender picks or drops a file. `Transfers` creates an `Outgoing` with a fresh 22-character transfer id and the
   sender's next offer number. It sends a sealed `offer` control message with the id, offer number, name, size and
   type over the `ctl` data channel.
2. The receiver drops an offer whose id is not 22 base64url characters and removes control, format and path
   characters from the name. For 5 seconds after the user declines, further offers are declined without a dialog.
   Otherwise the receiver shows the accept dialog. Accepting opens a save sink inside the click and derives the per-transfer
   key from the transfer id. The receiver creates an `Incoming` and sends `accept`. Declining sends `decline`.
3. The sender reads the file in 64 KiB slices, encrypts each slice with AES-GCM under the per-transfer key and the
   chunk index, and sends it as a framed binary message. It spreads chunks over connection 0 and any extra
   connections it has opened, always choosing the open channel with the least queued data.
4. The receiver opens each chunk as it arrives, drops duplicates and chunks from another transfer, holds
   out-of-order chunks in a bounded reorder buffer, writes them in file order and acknowledges progress.
5. When the receiver has written exactly the offered number of bytes, it closes the sink and sends `received`. The
   sender stops, both progress rows finish, and each side records one history row.

Only one outgoing and one incoming transfer run per side at a time, and both directions can run together.

### Flow control

| Constant | Value | Effect |
|---|---|---|
| `CHUNK_SIZE` | 64 KiB | Plaintext bytes per chunk. |
| `WINDOW` | 1024 chunks (64 MiB) | Chunks the sender may run ahead of the last ack; also the receiver's reorder window. |
| `BUFFER_HIGH` | 8 MiB | A channel with more queued data stops the send loop. |
| `BUFFER_LOW` | 1 MiB | The channel that drained below this wakes the send loop. |
| `ACK_EVERY` | 32 chunks | The receiver acks after this many written chunks. |
| `ACK_MS` | 500 ms | Or after this long since the last ack. |

The receiver authenticates a chunk before holding it, refuses more bytes than the offer declared, and aborts the
partial file on any failure.

### Extra data connections

WebRTC DataChannels on one connection share one congestion window, and some browsers cap a single connection far
below the link rate. The sender therefore spreads chunks over extra peer connections called lanes. Connection 0 is
the room's own connection; lanes are numbered 1 to 7 and exist only for one transfer.

- A lane copies connection 0's current configuration, except that when connection 0 is direct the TURN URLs are
  removed, since an unused TURN URL still books an allocation.
- Lane SDP and ICE travel as sealed control messages, never through the server. The server cannot tell that lanes
  exist.
- Growth: after sending starts, the sender measures how many bytes left all send buffers over a 3-second step. It
  opens lane 1, then adds another while each new lane lifts the rate by at least 1.2 times; a lower rate drops the
  newest lane and stops growth. A lane not open within 10 seconds counts as failed.
- `?lanes=N` with N from 1 to 8 opens N minus 1 lanes immediately, within the cap, and never adapts.
- When a lane fails, its unacknowledged chunks are queued again on the other lanes; duplicates are dropped by the
  receiver's reorder buffer.
- Lanes close on `received`, a cancel from either side, a failure, or when the room connection drops.

The connection cap is 8 connections per direction, connection 0 included, after a direct pairing. After a relayed
pairing the cap follows the relay's allocation quota (12 per TURN username, and both browsers usually share one
username because it is the expiry second): the code sets
`extra = max(0, floor(12 / (2 * max(1, turnUrls))) - 1)` and allows `1 + extra` connections for one direction, or
`1 + floor(extra / 2)` when files go both ways. Lane growth respects this cap.

### Pause and resume after a drop

A dropped connection does not throw a running transfer away. `Transfers` has one instance per room:

- The receiver keeps its sink open; the sender keeps its `File`. Both rows show Paused with Cancel.
- On the next connection, the receiver waits until chunks delivered on the old connection are written, then sends
  `resume` with the first chunk it has not written.
- The sender sends `pending` with the transfer id. A receiver that already finished that id answers `received`; one
  that no longer has it answers `cancel`.
- The sender continues from the requested chunk with the same key, the same offer number and a fresh set of lanes.
  A `resume` index is accepted only when it is not beyond what the sender handed over.

A transfer paused this way waits as long as the room lives. The room ending, a leave or a keep-alive timeout fails
both directions and removes the partial file. A page reload or a closed tab loses the `File` and the sink, so it also
ends the transfer.

### Cancel

Either side can cancel. Each chunk frame names its transfer, so frames still in flight are dropped by the receiver.

- The sender stops its loop, closes its lanes, then sends `cancel`. The receiver aborts its sink, so a new offer can
  follow immediately.
- The receiver aborts its sink, closes its lanes, sends `cancel`, and drops the rest of that file's frames.
- Cancelling the download in the browser's own download list counts as a receiver cancel.

## Saving

`save.ts` chooses a save path when an offer is answered. All paths implement the same `Sink` interface with
`write`, `close` and `abort`.

1. **Save picker** (`picker-sink.ts`). Used where `showSaveFilePicker` exists, in practice Chromium. The picker must
   open synchronously inside the accepting click. Chunks go to a `FileSystemWritableFileStream`. Abort aborts the
   writable and calls `FileSystemFileHandle.remove()` where the browser has it.
2. **Service Worker streamed download** (`sw-sink.ts`, `web/public/sw.js`). Used where a Service Worker controls the
   page and there is no picker, in practice Firefox and Safari. The page posts `{t:"dl", id, name, size, port}` to
   the worker, waits for `ready`, then loads `/dl/<id>` in a hidden iframe. The worker answers with the file as a
   `ReadableStream` body, `Content-Type: application/octet-stream`, `Content-Length` and
   `Content-Disposition: attachment`. The stream asks the page for one chunk per pull (high water mark 16), and chunk
   buffers are transferred rather than copied, so memory stays bounded. The page pings the worker every 10 seconds
   so it is not stopped mid-download. The worker reports when the frame's request reaches it. If that report does not
   come within 5 seconds, because the browser sent `/dl/<id>` to the network, the page
   drops the worker download and saves through OPFS instead. A browser-side cancel is posted back to the page and cancels the transfer. A
   page that is not yet controlled asks the worker to claim it.
3. **OPFS file** (`opfs-sink.ts`). Used when neither of the above is available. Chunks are written to the origin
   private file system under `incoming/<random name>`, chosen by the receiving page, never by the peer. When the file
   is complete the page downloads it through a temporary object URL and an `<a download>` click. If storage looks too
   small, the page asks for persistent storage after the user accepts, and checks again; the offer is declined if the file still does not fit. OPFS files older than one hour are
   removed on a later page load.

iOS and iPadOS take an OPFS variant: the file is written there but not downloaded, because a download from the
hidden iframe does not reach the Files app. The history row gets a Save button that opens the share sheet with the
`File`, or falls back to a download. If a browser has no usable save path, the offer is declined with a message that
this browser cannot save files. If the OPFS file does not fit even after asking for persistent storage, the offer is
declined with a message naming the browser's storage limit.

`index.html` and the page are served normally; `/dl/<id>` exists only inside the Service Worker, which builds the
response itself.

## Build

1. `build.rs` runs on every build unless `E2FT_WEB_PREBUILT` is set. It runs `npm ci` when `web/node_modules` is
   missing, then `npm run build`, and reruns when `web/src`, `web/public`, `web/scripts` or the package files
   change.
2. `npm run build` clears `web/dist`, copies `web/public/` into it and bundles the frontend with esbuild.
3. esbuild produces three files with the same settings (bundle, minify, ES module output, targets Chrome 120,
   Firefox 120 and Safari 17): `app.js` from `src/main.ts`, `jsqr.js` from the vendored jsQR, and `ristretto.js`
   from `src/crypto/ristretto.ts`. The two lazy chunks stay external imports in `app.js`: `ristretto.js` is loaded
   with `import()` when a room starts, and `jsqr.js` only when the scanner needs it.
4. `rust-embed` embeds `web/dist/` into the server binary at compile time.

Build-time settings (README) override the defaults in `web/src/config.ts`: `web/scripts/config.mjs` checks the
env values and `build.mjs` injects them into `app.js` through esbuild's `define`. `build.rs` checks the server's
copies (`ACCESS_LEN`, `KEEP_ALIVES`, `KEEP_ALIVE`), writes them into a generated Rust file, and reruns when any
setting's variable changes.

## Assets folder

At startup `src/assets.rs` builds one in-memory table of every file the server sends, and requests read only that
table, never the filesystem:

1. The embedded `web/dist/` files.
2. With `ASSETS_DIR` set, every file under `ASSETS_DIR/public/` over them at the same path. Symlinks are followed
   and names starting with `.` are skipped, so a ConfigMap volume works as the folder.
3. `app.js` with `?v=<first 12 hex of SHA-256>` on its two lazy import URLs.
4. `index.html`: each `ASSETS_DIR/slots/<name>.html` replaces the region between `<!-- slot:<name> -->` and
   `<!-- /slot:<name> -->` (without one, the default inside the markers stays; the markers go either way), then every
   local `src` or `href` that names a file in the table gets its stamp, then the version goes into the footer. The
   stamps prevent a cache or CDN from pairing a new page with an old script.

A slot file with no matching marker, an unbalanced marker or an unreadable `ASSETS_DIR` stops the server at startup.
Without the folder the app is the neutral default. `web/tests/assets/` is an example folder.

The `Dockerfile` builds the same thing in two stages: a Node stage runs the frontend build, and a Rust stage compiles
the server with `E2FT_WEB_PREBUILT=1` so it does not run npm again. The runtime image is distroless, runs as a
non-root user and listens on `0.0.0.0:8080`.

## What the server can see

It sees:

- The access key, the two seat tokens, the keep-alive and the pairing number.
- That a room exists and when its two sockets connect, disconnect, rejoin or leave.
- The size and timing of each relayed signalling frame, and the aggregate counters on `/metrics`.
- The IP addresses of the sockets at the network layer, though it does not log them.
- The TURN usernames it issues, which are only an expiry time.

With discovery turned on in a browser, the server also sees that page's device name and browser label, and which
other visible pages share its network. It holds the network only as a keyed hash in memory while the page is open,
and it sees which page asked which and the access key of the room that follows. With discovery off, none of this
exists.

It cannot see:

- The secret, the CPace session key, or any derived AES key.
- SDP, ICE candidates, shared TURN credentials or control messages, which are sealed end to end.
- File names, sizes, types or contents.
- That extra lane connections exist, because their signalling stays on the sealed control channel.

During the first pairing, the first two binary payloads from each side are the CPace public share and confirmation
tag. These are public values and reveal nothing about the secret.

In a discovered room the exchange has no secret, so a malicious server could run one exchange with each side. The
creator's commitment and the code both people compare catch that (protocol, "Discovered rooms").

A malicious server can still refuse service, delay or drop frames (which breaks a sealed stream), keep a room alive
while it holds a seat, and issue TURN credentials to itself. The relay carries ciphertext only. Because the pairing
number is part of the signalling stream's associated data (the label `sig/<gen>`), signalling frames from an earlier
pairing cannot be replayed into a later one, and a strict sequence number rejects replay, reordering and dropped
frames inside a pairing.
