# Protocol

This document describes the wire protocol of e2ft precisely enough to write a compatible client. Field names,
labels, lengths and constants are the ones in the code: `web/src/crypto/*.ts`, `web/src/net/*.ts`,
`web/src/transfer/wire.ts`, `src/relay.rs` and `src/rooms.rs`. Lengths, keep-alives and flow-control numbers are the
defaults of the build-time settings (README, Build-time settings); a build may change them.

## Conventions and roles

- **Creator** (A, the CPace initiator): the browser that calls `create`.
- **Joiner** (B, the CPace responder): the browser that calls `join`.
- **accessKey**: 8 Crockford base32 characters, the room id the server sees.
- **secret**: 6 Crockford base32 characters, the CPace password. It never goes to the server.
- **seat token**: 22 base64url characters, 16 random bytes, created per room and role. It proves seat ownership to
  the server and is never typed.
- **transfer id**: 22 base64url characters, 16 random bytes, fresh for every offered file.
- All JSON is UTF-8 and field names are case-sensitive.
- base64url means the URL-safe alphabet without padding (`-` and `_`, no `=`).
- Crockford base32 means the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, with `I` and `L` read as `1`, `O` read as
  `0`, case ignored, and spaces and hyphens dropped.

## Transport

The signalling transport is a WebSocket at `/ws` on the same origin, `wss:` when the page is `https:`.

- Application frames are text (a JSON server event or hello) or binary (a relayed peer payload). The server also
  sends WebSocket ping and close control frames.
- The server refuses a frame above 64 KiB.
- One client address (IPv6 by its /64) may hold 16 open sockets; the next gets `too-many` and is closed.
- One client address may hold 16 live rooms it created, and the /64s of one IPv6 /48 256 together; the next
  `create` gets `too-many`. A room counts until it ends, its creator away or not.
- A socket may relay 256 KiB of binary frames at once, then 16 KiB per second; past that it gets `rate` and is
  closed.
- The server sends a WebSocket ping every 15 seconds. A socket that sends no frame, pongs included, for 40 seconds is
  treated as closed, and its seat goes away.
- A client may send at most one hello. A second hello, a binary frame before the hello, a hello that does not parse,
  or any text frame after the hello other than the exact leave frame or the exact ICE request closes the socket.
- After the hello, `{"t":"ice"}` asks for fresh `iceServers` for a new connection. The server answers with an `ice`
  event only while the other seat is connected, and counts the request against the socket's relay budget.

## Client hello

The first text frame from each browser is one of these three objects.

| `t` | Fields | Meaning |
|---|---|---|
| `create` | `room`, `token`, optional `keepAlive` | Start a room; the sender becomes the creator. |
| `join` | `room`, `token` | Take the joiner seat. |
| `rejoin` | `room`, `token`, `role` | Take an existing seat back after a socket drop. `role` is `"creator"` or `"joiner"`. |

Field rules:

| Field | Rule |
|---|---|
| `room` | Exactly 8 characters, each in `A-Z a-z 0-9 - _`. This is the canonical accessKey; the server does not normalize it. |
| `token` | Exactly 22 characters, each in `A-Z a-z 0-9 - _`. |
| `keepAlive` | Optional on `create`; an integer and one of `0`, `60`, `300`, `900`, `1800` seconds. Default `300` when absent. |
| `role` | Exactly `"creator"` or `"joiner"`. Only on `rejoin`. |

A hello with a valid shape but a refused operation gets an `error` event and the server closes the socket:

| Error `e` | Cause |
|---|---|
| `exists` | `create` for an access key that already has a room. |
| `not-found` | `join` for a missing room, or `rejoin` for a missing room, a wrong token, or the token of the other seat. |
| `full` | `join` when the joiner seat has ever been taken, including when it is away. |
| `keep-alive` | `create` with a `keepAlive` outside the allowed set. |
| `busy` | `create` while the server already holds its maximum of rooms. |

The server also ends a socket with an `error` event, hello or not, for these:

| Error `e` | Cause |
|---|---|
| `too-many` | The client address already holds 16 open sockets, sent before any hello; or, on `create`, it already holds 16 live rooms it created (an IPv6 /48 holds 256 together). |
| `rate` | The socket relayed binary frames faster than its byte rate. |
| `unjoined` | Sent to the creator: nobody took the joiner seat within the room's wait (15 minutes by default), so the room was deleted. |

A hello with a wrong key length or unparsable JSON gets no error event: the socket is closed.

## Server events

The server sends these text frames.

| `t` | Sent to | Fields | Meaning |
|---|---|---|---|
| `created` | creator | none | The room exists and the creator seat is held; waiting for the joiner. |
| `joined` | joiner | `iceServers`, `gen`, `keepAlive` | The joiner seat was taken. A `peer-away` may follow if the creator is away. |
| `peer-joined` | creator | `iceServers`, `gen`, `keepAlive` | The joiner arrived. |
| `rejoined` | rejoining peer | `iceServers`, `gen`, `keepAlive` | The seat was taken back and the other seat is connected. |
| `rejoined` | rejoining peer | none | The seat was taken back but the other seat is empty or away. A `peer-away` follows in the away case. |
| `peer-back` | the peer that stayed | `iceServers`, `gen`, `keepAlive` | The other peer rejoined and is connected again. |
| `peer-away` | the connected peer | `wait` | The other seat is away. `wait` is the remaining keep-alive in seconds. |
| `peer-left` | the connected peer | none | The other peer left, or its away seat expired. The room is deleted and the server closes the socket. |
| `error` | the peer whose hello was refused | `e` | One of the codes above. The server then closes the socket. |
| `ice` | the peer that sent `{"t":"ice"}` | `iceServers` | Fresh servers for a new connection in the current pairing. |

`iceServers` is an array in the shape of `RTCIceServer`:

```json
[
  { "urls": ["stun:stun.example.com:3478"] },
  { "urls": ["turn:turn.example.com:3478"], "username": "<unix-expiry>", "credential": "<hmac>" }
]
```

The TURN username is the Unix expiry time 2 minutes ahead as a decimal string, and the credential is
`base64(HMAC-SHA1(TURN_SECRET, username))`. Only a paired peer receives the TURN entry. `keepAlive` in a pairing
event is the room's keep-alive in seconds.

coturn checks the expiry only when an allocation is created. Refreshes and permissions on an existing allocation
keep working after it, so connection 0 lasts as long as the room. Each extra transfer connection allocates anew, so
before opening them a relayed browser sends `{"t":"ice"}` and puts the fresh username and credential into its TURN
entry. If the answer does not come within 2 seconds, the connections open with the old ones.

### Pairing number (`gen`)

Each room starts with pairing number 0. Every accepted `join` or `rejoin` increments it by 1 and it appears in every
pairing event. Both sides use it to label the signalling stream for that pairing, so a frame from an earlier pairing
is dropped or fails to open. `gen` is not secret.

### The binary relay frame

Every binary frame from a client is:

```
uint32 big-endian gen || payload
```

The server relays the whole frame unchanged to the other connected seat. It does not parse `gen` or the payload. If
the other seat is away or empty, the frame is dropped. Each peer has a queue of 256 outbound frames; a full queue
drops frames. A client drops an inbound binary frame whose `gen` is not the current pairing.

During the first pairing only, the payloads are CPace messages: first the 32-byte public share, then the 64-byte key
confirmation tag. Every later payload is a sealed signalling frame.

## Invite

The invite is a normal page link with the room settings and secret in the fragment, which browsers never send to a
server:

```
<origin>/r/<accessKey>#<config><secret>
```

- `accessKey`: 8 Crockford characters, 40 random bits.
- `secret`: 6 Crockford characters, 30 random bits. It is the CPace password.
- `<config>`: 2 Crockford characters, 10 bits, representing the creator's non-default room hints.

The two config characters hold the 10-bit value with its high 5 bits in the first character:
`CROCKFORD[flags >> 5]` then `CROCKFORD[flags & 31]`.

| Bits | Meaning |
|---|---|
| 0 to 2 | Keep-alive index into `[300, 0, 60, 900, 1800]` seconds. |
| 3 to 4 | Connection index into `["auto", "relay", "tcp"]`. |
| 5 | `shareTurn`: 1 means the creator will send its own TURN server. |
| 6 to 9 | Spare, written as 0 and ignored on read. |

A default room has config `00`: keep-alive 300 seconds, automatic connection, no shared TURN. The hints are
untrusted. The sealed `relay` and `turn` messages decide the actual behavior. `hideQr` and `alwaysTurn` are never
part of an invite.

Parsing rules:

1. Normalize the text: upper case, remove whitespace and `-`, read `I` and `L` as `1` and `O` as `0`, and require
   every character to be in the Crockford alphabet.
2. The last 6 characters are the secret.
3. An empty prefix means the default hints. Exactly 2 prefix characters mean hints read from the flags, unless a
   keep-alive or connection index is out of range.
4. Any other prefix length, or an out-of-range index, means the hints are unknown. The join still proceeds.
5. A typed Secret Key field may hold the whole 8-character fragment; the same parse takes the last 6 as the secret.

The same access key and secret are generated by taking the low 5 bits of a random byte per character. The joiner's
page removes the fragment from the address bar and history with `history.replaceState` on load.

## Key schedule

The 30-bit secret is never used as a key. It is the CPace password. CPace produces a 64-byte session key, the ISK,
and every other key is derived from it.

| Key | Derivation | Use |
|---|---|---|
| ISK | CPace output, 64 bytes (below). | Input to HKDF for the room keys; zeroed after use. |
| Signalling key | HKDF-SHA-256 with input key material ISK, salt `"e2ft/v1"`, info `"signal/<accessKey>"`; output a non-extractable 256-bit AES-GCM key. | Seals signalling frames (label `sig/<gen>`) and control messages (label `ctl`). |
| File key | HKDF-SHA-256 with input key material ISK, salt `"e2ft/v1"`, info `"file/<accessKey>/<transferId>"`; output a non-extractable 256-bit AES-GCM key. | Seals the chunks of one transfer. |

The access key in an info string is the canonical upper-case 8-character form. Each transfer has a fresh random
`transferId`, so chunk counters never repeat under one key. The signalling key is derived once per room; later
pairings reuse it with a new label.

## CPace key exchange

e2ft implements draft-irtf-cfrg-cpace-21 in the initiator-responder setting, with the creator as A. Parameters:

| Parameter | Value |
|---|---|
| Group | ristretto255 |
| Hash | SHA-512 |
| DSI | `"CPaceRistretto255"` |
| ISK DSI | `"CPaceRistretto255_ISK"` |
| PRS | the canonical 6-character secret as ASCII bytes |
| CI | `lv_cat("e2ft/v1", accessKey)` |
| sid | empty |
| ADa (creator) | `"creator"` |
| ADb (joiner) | `"joiner"` |

`lv(x)` is the length of `x` as LEB128 followed by `x`; `lv_cat(a, b, ...)` concatenates the length-prefixed parts.

Steps:

1. Both sides compute `CI = lv_cat("e2ft/v1", accessKey)` and the generator
   `gen = ristretto255_derive_to_curve(SHA-512(generator_string))`, where

   ```
   generator_string = lv_cat(DSI, PRS, zeroes, CI, sid)
   zeroes = max(0, 128 - 1 - len(lv(PRS)) - len(lv(DSI))) zero bytes
   ```

   The zero padding follows the draft so DSI and PRS fill the first 128-byte SHA-512 block.
2. Each side samples a secret scalar `y`: 32 random bytes with the top 4 bits of the last byte cleared
   (`y[31] &= 0x0f`), read as a little-endian integer and rejected if zero. Its public share is
   `Y = y * gen`, encoded as a 32-byte ristretto255 point.
3. Both send their share first, in a binary `/ws` frame with the 4-byte `gen` prefix. The creator's share is Ya and
   the joiner's is Yb.
4. On receiving the peer share, a side decodes it as a ristretto255 point, rejects a point that does not decode or
   that is the identity, computes `K = y * peerShare`, and rejects K if it is the identity. Then:

   ```
   ISK = SHA-512( lv_cat(DSI_ISK, sid, K) || lv_cat(Ya, ADa) || lv_cat(Yb, ADb) )
   mac_key = SHA-512( "CPaceMac" || sid || ISK )
   tag = HMAC-SHA-512( mac_key, lv_cat(own share, own AD) )
   ```

   `ISK` is 64 bytes and `tag` is 64 bytes. The outer ISK input is plain concatenation of the three length-prefixed
   groups; `mac_key` uses plain concatenation of `"CPaceMac"`, `sid` and `ISK`.
5. Each side sends its tag second, in a binary `/ws` frame with the 4-byte `gen` prefix, after receiving the peer's
   share. It then verifies the peer's tag with the peer's share and the peer's AD. Only after a valid tag is the ISK
   released to the key schedule.

The role names as AD stop a relay from reflecting one side's share or tag back to it, because the reflected role
does not match.

Failure rules:

- An invalid peer share or a bad peer tag ends the session with a wrong-secret error. Each side sends a leave, so the
  other side sees the room end.
- A run that ends before the side sent its own tag (peer went away, socket lost) starts a fresh run with a fresh
  scalar on the next pairing. This lets a rejoin resume the exchange.
- A run that ends after the side sent its own tag ends the session instead. A peer that saw the tag may have tested
  one guess of the secret, and the design allows only one guess per room.
- Once keys exist, a later pairing event runs no new CPace; it only builds a new sealed stream.

### Discovered rooms: commitment and compared code

A room between two devices that found each other on one network (see Discovery) has no secret. Both sides run the
same exchange with the fixed, public PRS `discovered`, so the exchange alone proves nothing: a relay could run one
exchange with each side. Two additions close that gap.

1. **Commitment.** The creator's first payload is not its share but `SHA-512("e2ft/v1/commit" || Ya)`, 64 bytes.
   The joiner sends its share only after it has the commitment. The creator then sends its share, and the joiner
   checks that the share opens the commitment before it goes on; a share that does not ends the session. The tags
   follow as above. Each side's share is therefore fixed before it sees the other's, so a relay in the middle cannot
   try shares until the two codes below come out equal.
2. **Compared code.** After both tags verify, each page derives 32 bits with HKDF-SHA-256 from the session key (salt
   `e2ft/v1`, info `sas/<accessKey>`), reduces them modulo 1 000 000 and shows the 6 digits. The two people compare
   the screens. Each page that is told the codes match sends the sealed signalling message `{t:"match"}`. A page
   releases the pairing event, and so creates its peer connection, only after it sent its own `match` and received
   the peer's. Any other sealed message before that ends the session.

A relay that sits between two exchanges holds two different session keys, and the two screens then show the same
code with a chance of one in a million per attempt. "No match" on either side leaves the room. A pairing that ends
before both confirmations (peer away, socket lost) ends the session, since a later pairing would start unverified.
A discovered run is also never restarted once a side sent its share: the joiner after it answered a commitment, the
creator after it revealed. Otherwise a relay could announce pairing after pairing, collect a fresh share each time
and stop at the one whose code matches.

## Discovery

Optional and off by default. A home page whose user turned on "Visible to devices on my network" opens a second
WebSocket at `/discover`. Everything on it is clear text that the server reads; it carries no secret and no key.

| Direction | Frame | Meaning |
|---|---|---|
| client → server | `{"t":"hello","name":"<name>","device":"<label>"}` | first frame, and again after a rename; each label is 1 to 32 characters without control characters, anything else closes the socket |
| server → client | `{"t":"devices","devices":[{"id","name","device"}]}` | the other visible pages of this network, sent on every change; `id` is a random per-socket number as 16 hex characters |
| client → server | `{"t":"ask","to":"<id>"}` | ask that device to start a room |
| server → client | `{"t":"asked","from":"<id>"}` | another device of this network asks |
| client → server | `{"t":"answer","to":"<id>","room":"<accessKey>"}` | accepted: the room this page created; without `room` the ask is declined |
| server → client | `{"t":"answered","from":"<id>","room":...}` | the answer, `room` null when declined |

The server groups sockets by network: the client's public IPv4 address, or the /64 of its IPv6 address. It keeps
only a SHA-256 of that under a random per-process key, in memory, for as long as the socket is open. Private,
link-local, shared (100.64.0.0/10) and loopback-from-a-header addresses form no group; such a page stays connected
and is listed to nobody. A group holds at most 32 pages. One client address (IPv6 by its /64) may hold 32 open
`/discover` sockets, counted apart from `/ws`; the next is closed before its hello, and the page tries again later. `ask` and `answer` reach only an `id` of the sender's own
group. Frames above 4 KiB are refused. The server pings every 5 seconds and drops a socket that sends no frame,
pongs included, for 15 seconds, so a page that lost its network leaves the other lists quickly; `/ws` waits longer
because a room seat must survive a suspended phone. Each socket may send 5 `hello` frames in a row and then one per
second, and the same for `ask`; a frame over that limit closes the socket. A `hello` that changes nothing sends no
new list. A page that declined an ask declines further asks from the same `id` for 30 seconds without asking its
user.

The page that accepts an ask creates an ordinary room with a fresh access key (`create` on `/ws`) and sends the
`answer` once the server said `created`; the asking page then joins it. Both pages close `/discover` when they leave
the home screen. The room is a discovered room as described above.

## Sealed signalling stream

All signalling messages (`sdp`, `ice`, `turn`, `relay`) and all control messages on the data channels use the same
AEAD construction, an instance of `Sealer`.

Frame layout:

```
iv (12 random bytes) || AES-GCM ciphertext (includes the 16-byte tag)
```

The plaintext is the UTF-8 JSON of:

```json
{ "s": <sequence number>, "m": <message object> }
```

The additional authenticated data is the UTF-8 string:

```
<label>:<sender role>
```

| Label | Stream | Used for |
|---|---|---|
| `sig/<gen>` | `/ws` binary frames | SDP, ICE, shared TURN and relay mode messages. One stream per pairing. |
| `ctl` | connection 0's `ctl` data channel | File control messages. A new stream per connection. |

`sender role` is `creator` or `joiner`. The receiver builds the expected AAD with the peer's role, so a relay cannot
reflect a peer's own messages back to it, and a `sig` frame cannot be replayed as a `ctl` frame.

Sequence rules:

- Each Sealer has its own send counter and receive counter, both starting at 0. The sender writes `s` and increments;
  the receiver requires `s` to equal its next expected value and increments.
- Replay, reordering and dropped frames therefore fail.
- The first failure of any kind (frame too short, bad tag, wrong sequence, bad JSON) poisons the stream. The page
  ends the session with a "did not verify" message and closes the socket.
- A new pairing gets a new `sig/<gen>` stream with fresh counters, and a new connection gets a new `ctl` stream with
  fresh counters on both sides.
- Because the pairing number is part of the label, and therefore part of the AAD, a signalling frame from an earlier
  pairing fails to open even if its 4-byte prefix is rewritten. Random 12-byte IVs make nonce reuse across pairings
  impossible.

## Signalling messages

These are sealed with label `sig/<gen>` and sent as the payload of a binary `/ws` frame.

| `t` | Fields | Sent by | Meaning |
|---|---|---|---|
| `sdp` | `d`: `RTCSessionDescriptionInit` | both | An offer or answer. The creator makes the offer. |
| `ice` | `c`: `RTCIceCandidateInit` or `null` | both | One ICE candidate; `null` marks the end of candidates and is ignored. |
| `turn` | `urls`, `username`, `credential` | creator | Its own TURN server, when the creator chose to share it. Sent before the offer on every pairing. |
| `relay` | `tcp`: boolean | creator | The creator's custom room is relay-only. Sent after `turn`, before the offer, only when the mode is not automatic. |

The joiner applies signals in arrival order. A `turn` message that arrives after the offer, or that fails validation
(`urls` must be non-empty `turn:` or `turns:` URLs, `username` and `credential` non-empty strings), is dropped. A
`relay` message without a boolean `tcp`, or one that arrives after the offer, is dropped. The joiner applies `relay`
on top of the final TURN configuration. An unknown `t` ends the session.

## Data channels

Both sides create the same two channels on every connection, negotiated and ordered (reliable):

| Name | Id | Type | Carries |
|---|---|---|---|
| `share` | 0 | binary | File chunk frames. |
| `ctl` | 1 | text | base64url of sealed control messages. |

The channels are negotiated, so neither side sends an in-band channel offer. The session is considered open when
both channels are open. Control has its own receive chain, separate from the single chunk chain that every lane
feeds, so a slow disk write never delays reading an ack.

## Control messages

Control messages are sealed with label `ctl` and the signalling key, then encoded as base64url text on the `ctl`
channel. The message object is the `m` field of the sealed JSON. The fields:

| `t` | Fields | Sent by | Meaning |
|---|---|---|---|
| `offer` | `id`, `x`, `name`, `size`, `type` | sender | Offer one file. `x` is the sender's offer number as a `uint32`, repeated in every chunk frame. |
| `accept` | `id` | receiver | The save sink is open; send the file. |
| `decline` | `id` | receiver | The offer was declined, cancelled in the picker, or arrived while another transfer was running. |
| `ack` | `id`, `n` | receiver | `n` chunks have been written in order. Sent after every 32 written chunks, or 500 ms since the last ack. |
| `received` | `id` | receiver | The whole file is written and the sink is closed. |
| `cancel` | `id` | either | Withdraw the offer, stop the transfer, or answer a `resume` or `pending` for an unknown `id`. |
| `resume` | `id`, `n` | receiver | First message on a new connection for a paused incoming transfer: send again from chunk `n`, the first not written. |
| `pending` | `id` | sender | First message on a new connection for a paused outgoing transfer. The receiver answers `received` if this is the file it last finished, `cancel` if it no longer has it, and nothing if the transfer is its own paused incoming one. |
| `lane` | `id`, `n`, `d` | sender offers, receiver answers | SDP of extra data connection `n` for transfer `id`. |
| `lane-ice` | `id`, `n`, `c` | both | One ICE candidate for extra data connection `n`; `null` marks the end. |

An `offer` is valid only when `id`, `name` and `type` are strings, `size` is a safe integer at least 0, and `x` is a
safe integer from 0 to 4294967295. The receiver truncates `name` and `type` to 255 characters. Any other message
shape fails the session.

`id`, `name` and `type` are the offered file's metadata. They travel sealed and are never sent to the server.
`x` starts at 0 for the first offer in a room and increments per outgoing offer; it is separate from `id`.

The receiver drops a chunk frame whose `x` is not its current incoming transfer's offer number. That is how
cancelled and ended transfers discard frames still in flight.

## Chunk frames

Chunks travel as binary messages on the `share` channel and on every open lane channel.

Frame layout:

```
uint32 big-endian x || uint32 big-endian index || AES-GCM ciphertext (includes the 16-byte tag)
```

- `x` is the sender's offer number from the `offer` control message.
- `index` is the zero-based chunk number in the file. The last chunk may be shorter than 64 KiB.
- The plaintext of chunk `index` is `file.slice(index * 65536, (index + 1) * 65536)`.
- The IV is 12 bytes: four zero bytes followed by the index as a `uint64` big-endian.
- The key is the per-transfer file key from the key schedule.
- The additional authenticated data is empty. The index in the IV binds the ciphertext to its place, so a forged
  prefix fails to decrypt, and a chunk is valid on any connection.

A frame shorter than 8 bytes is invalid. The receiver opens each chunk on arrival, before holding it, so only
authenticated chunks are buffered.

Ordering and flow:

- The sender chooses the open channel with the least queued data.
- It pauses while that channel holds more than 8 MiB and resumes when it drops below 1 MiB.
- It stays at most 1024 chunks (64 MiB) ahead of the last ack.
- The receiver drops duplicate indices and indices before the first unwritten one, and rejects an index 1024 or more
  beyond it.
- It writes chunks in order to the sink, refuses more bytes than the offer declared, and closes the sink when the
  written byte count equals the offered size.
- It acks the index of the next unwritten chunk after every 32 written chunks, or 500 ms since the last ack.
- Any failure ends the session and aborts the partial file.

## Extra connections (lanes)

Connection 0 is the room's own peer connection and carries the `share` and `ctl` channels. A sender may open up to
7 extra peer connections per transfer to spread chunks over several congestion windows.

1. The sender creates lane `n` (1 to 7) with connection 0's current `RTCConfiguration`. If connection 0 is direct,
   the sender removes every `turn:` and `turns:` URL from the lane's configuration, so the lane books no TURN
   allocation.
2. The lane has one negotiated, ordered, binary channel named `lane` with id 0. The sender sends its SDP as a sealed
   `lane` control message with the transfer `id` and the lane number `n`.
3. The receiver accepts a `lane` message only for its current incoming transfer, and only when `n` is an integer
   from 1 to 7. It creates a matching lane, applies the offer, and answers with a sealed `lane` message.
4. Each side sends its candidates as sealed `lane-ice` messages with the same `id` and `n`, and a final `null`
   candidate. Signalling for lanes goes only over the `ctl` channel, never through `/ws`, so the server cannot tell
   lanes exist.
5. A lane not open within 10 seconds is treated as failed. A lane whose channel closes or whose ICE state becomes
   `disconnected` or `failed` is dropped; its unacknowledged chunks are queued again on the other lanes, lowest
   index first.
6. Lanes close on `received`, a cancel from either side, a failure, or when connection 0 drops. The next connection
   starts new lanes.

The sender may use at most 8 connections in one direction (connection 0 included) after a direct pairing. After a
relayed pairing the cap follows the relay's per-username allocation quota of 12. With `u = max(1, turnUrls)`,
`extra = max(0, floor(12 / (2 * u)) - 1)` and one direction may use `1 + extra` connections. When both directions
run at once the extra connections are halved: `1 + floor(extra / 2)`. `?lanes=N` in the page URL opens N minus 1
lanes at once within the cap and never adapts.

## Pause and resume

When connection 0 drops, the room may still be alive and the transfer pauses:

1. The sender stops sending, closes its lanes and keeps its `File`. The receiver keeps its sink open.
2. Both sides rejoin. The server pairs them again with a higher `gen`, and new data channels are created.
3. Both sides create a new `ctl` sealer, so control sequence numbers restart at 0.
4. The sender sends `pending` for its paused outgoing transfer. The receiver sends `resume` with the first chunk it
   has not written, after writing everything the old connection delivered.
5. The sender accepts `resume` when `0 <= n <= sent`, where `sent` is the number of chunks it has handed to a channel
   at least once, so `sent` is the next index it has not used. It continues from `n` with the same key and offer
   number, and grows new lanes from one.
6. A receiver that already completed that transfer answers `pending` with `received`; one that no longer has it
   answers `cancel`.

A transfer paused this way waits as long as the room exists. The room ending, a leave or a keep-alive expiry fails
both directions and removes the partial file. A page reload or closed tab loses the `File` and the sink, so it ends
the transfer too.

## Cancel and close

- The sender cancels: its send loop stops, its lanes close, and it sends `cancel`.
- The receiver cancels: it aborts the sink, closes its lanes, sends `cancel`, and drops the rest of that file's
  frames.
- A browser download cancelled in the browser's own download list reaches the page as a receiver cancel.
- Any leave, session end, `beforeunload`, or non-restore `pagehide` sends `{"t":"leave"}`. The server deletes the
  room and tells the other side `peer-left`.
- A socket that closes without a leave instead makes the seat away for the room's keep-alive, unless that is 0, in
  which case the room is deleted at once.
