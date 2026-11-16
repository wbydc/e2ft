# Security

## Reporting a vulnerability

Please report security problems privately, through the hosting platform's private vulnerability reporting for this
repository (for example GitHub's "Report a vulnerability" under the Security tab). Do not open a public issue. Include
the steps to reproduce, the browser and version, and what an attacker gains. You will get an answer, and a fix will be
released before the details are published.

## Threat model

e2ft moves a file between two browsers. The server that serves the page and relays signalling is **untrusted by
design**: the protocol must keep the file and its metadata confidential even when the server, or anyone on the network
path, is hostile. The exact protocol is in [docs/protocol.md](docs/protocol.md).

### What protects the transfer

- **The secret never leaves the browsers.** An invite carries a room id (the access key, 8 Crockford base32
  characters, which the server knows) and a secret (6 Crockford base32 characters). The secret travels in the link's
  fragment (`#...`), which browsers do not send to servers, or is typed by hand.
- **CPace turns the short secret into a strong key** (draft-irtf-cfrg-cpace on ristretto255 with SHA-512,
  `web/src/crypto/cpace.ts`, `web/src/crypto/key-exchange.ts`). The exchange runs through the relay. Someone without
  the secret, including the server, cannot learn the key from what they see, cannot test guesses offline, and gets at
  most one online guess per exchange. Key confirmation follows: a wrong secret ends the room on both sides before any
  sealed message is sent.
- **Everything after the exchange is sealed.** WebCrypto HKDF-SHA-256 derives AES-256-GCM keys from the CPace session
  key (`web/src/crypto/keys.ts`): one for signalling, and one per file, keyed to a random transfer id. Signalling
  messages carry a strict sequence number and the sender's role in the authenticated data, so a replayed, reordered or
  reflected message is rejected and ends that stream (`web/src/crypto/sealer.ts`). SDP and ICE candidates go only
  inside sealed messages, so the server cannot splice itself into the WebRTC connection.
- **Files are encrypted twice.** Each chunk is AES-GCM sealed with the file key and a counter nonce that never repeats
  under one key, and the WebRTC data channel adds its own DTLS layer. File names, sizes and types travel only inside
  the sealed stream.
- **Nothing is stored.** Rooms live in the server's memory and end when either side leaves, or when a side stays away
  longer than the room's keep-alive. A room nobody joins is deleted after 15 minutes. The server writes no logs of room ids, tokens or addresses. The optional metrics
  listener reports aggregate counts only.
- **The page is locked down.** Every response carries a strict Content-Security-Policy (`default-src 'self'`, no
  inline scripts, no framing), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, HSTS,
  `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that allows only the camera and the screen
  wake lock (`src/web/http.rs`).
- **The server is hard to abuse.** It holds at most 10 000 rooms, 16 live rooms, 16 open signalling sockets and 32 open discovery sockets
  per client address (an IPv6 address counts by its /64, and one /48 holds at most 256 rooms), and
  each socket may relay only signalling-sized traffic (256 KiB at once, then 16 KiB per second).

- **A discovered room is checked by eye.** A room started from the device list has no secret, so the key exchange
  alone would not stop the server from sitting between the two devices. The creating device first commits to its
  public share and reveals it only after the other device sent its own, and both screens then show 6 digits derived
  from the session key. A server in the middle holds two different keys and cannot steer the two codes to match; its
  chance is one in a million per attempt. Nothing connects until both people confirm the code.

### What the server and the network can still see

- The access key, the seat tokens, when each side connects, and the number, size and timing of sealed frames.
- IP addresses of both browsers at the transport level, and the TURN relay sees the addresses it relays for. A direct
  WebRTC connection also shows each browser's IP to the other person. The "Always use TURN" setting keeps a browser's
  IP from the other person, at the cost of speed; the relay still sees it.
- The approximate size of a file, from the volume of traffic.
- With "Visible to devices on my network" on (off by default): the device name and browser label you show, which
  other visible devices share your public address, and who asked whom to start a room. The server keeps the address
  only as a keyed hash in memory while the page is open. Everyone behind the same public address who also turned it
  on sees your device name; on a carrier-grade NAT or a shared network those are strangers.

### What this design does not protect against

- **A malicious operator serving altered code.** The page and its scripts come from the server. An operator who
  changes them can read everything. Use an instance you trust, or host your own.
- **A compromised browser or device** at either end.
- **Sharing the invite with the wrong person.** Anyone holding the full invite can join, and the room takes only two
  people. Send the secret over a channel you trust, or send the keys separately.
- **Guessing the secret online.** The 6-character secret has about 30 bits. Each wrong guess costs one exchange and ends
  that room, so guessing is slow and visible, but a short secret is still a short secret.
- **Confirming a code without comparing it.** A discovered room is only as safe as the comparison. If the two
  screens show different digits and you tap "It Matches" anyway, a server in the middle can read the transfer.
- **Traffic analysis** of sizes and timing, as listed above.
