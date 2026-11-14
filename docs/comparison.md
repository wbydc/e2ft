# How e2ft compares

This page compares e2ft with five other browser file transfer tools: PairDrop, FilePizza, WebWormhole,
transfer.zip, and Wormhole.app, from each project's own documentation as of 2026-11-09 (GitHub stars from the
GitHub API that day), and e2ft as of version 0.10. Cells marked "Not documented" are things the project does not
state; check it before relying on them.

| Project | Accounts | Room or link | Secret path | Server can read or MITM? | Files stored server-side | Save-location picker | Self-hosting | License | Stars |
|---|---|---|---|---|---|---|---|---|---|
| e2ft | No | Two-way room; either side can send; opt-in discovery of devices on the same network | Secret in the URL fragment, used in CPace; never sent | No; sealed signalling fails if altered | No | Yes on Chromium; streamed download or OPFS elsewhere | Yes | AGPL-3.0 | new |
| PairDrop | No | Temporary public rooms and device pairing | Room or pairing code goes to the server | Yes; DTLS only, so the signalling server is trusted | No; P2P with TURN fallback | No; browser download | Yes | GPL-3.0 | 11.8k |
| FilePizza | No | One-way link from uploader to downloader | Channel id in the link goes to the server | The signalling server is trusted for the handshake; an optional password adds a check | No; P2P with optional TURN | No; streamed download | Yes | BSD-3-Clause | 10.3k |
| WebWormhole | No | One-shot, one-way transfer | One-time code is a CPace password; never sent | No; the PAKE authenticates the exchange | No; P2P | No; browser download | Yes | BSD-3-Clause | 2.1k |
| transfer.zip | Not documented for Quick Transfers | One-way link; Quick Transfers are P2P while both are online | A random 256-bit AES-GCM key in the link or QR code | Not for file data, which is sealed with that key; the handshake is not keyed | Quick Transfers: no; Stored Transfers: yes, until expiry | Not documented | Yes | AGPL-3.0 | 1.5k |
| Wormhole.app | Not documented (hosted service) | One-way link; upload first, download later | Files are encrypted in the browser before upload | No for file content | Yes, up to 24 hours | Not documented | No | Proprietary | n/a |

## e2ft

e2ft combines a two-way room, a secret that never reaches the server, no server-side storage, and a save-location
picker where the browser offers one. Both people must be online at the same time, and a room does not survive a
server restart. The server cannot read the exchange, but it can still block or drop it.

Since version 0.10, e2ft can also find devices on the same network, off by default. Devices behind one public
address that turned it on list each other by name, and a tap starts a room without an invite. The server introduces
the devices, so it is not trusted to pair them honestly: both screens show a 6-digit code derived from the key
exchange, and nothing connects until both people confirm it matches. The server sees the device names, and devices
on different networks cannot find each other; there is no pairing that remembers a device.

## PairDrop

PairDrop is the closest tool in scope. It supports temporary public rooms and pairing between devices, so people
on the same network can find each other without an invite. It uses WebRTC DTLS, but the room or pairing code goes
through its server and the server relays the handshake, so the server is a trust anchor: a malicious server could
replace the DTLS fingerprints. It has no save-location picker. Its pairing of devices across networks and its public
rooms are real advantages; e2ft's discovery covers only devices behind one public address, but it checks the
pairing with a compared code instead of trusting the server.

## FilePizza

FilePizza turns an upload into a link. The sender keeps the page open while the receiver downloads, and the
receiver streams the file through a Service Worker with progress, without holding it in memory. The flow is
one-way by design, the signalling server is trusted for the handshake, and there is no save-location picker. Its
short upload-then-share flow and its streaming download are its advantages.

## WebWormhole

WebWormhole uses the same core idea as e2ft: a one-time code is a CPace password, and the key exchange
authenticates the relayed SDP, so the signalling server cannot read or alter the exchange. It is built for one
transfer, not for a room, and it has no save-location picker. Its small, single-purpose flow is its advantage.

## transfer.zip

transfer.zip has two modes. Quick Transfers stream a file over WebRTC, sealed with AES-GCM under a random 256-bit
key carried in the link or QR code, and fall back to relaying through the signalling server, which it uses for files
over 10 MB even when a direct connection works. Stored Transfers upload the file to the server or S3 storage with
resumable uploads, so the receiver can download later without both people being online. It is self-hostable under
AGPL-3.0. Its strengths are the stored mode, transfer requests and custom branding; the link carries the full key,
and transfers go one way.

## Wormhole.app

Wormhole.app is a hosted service. It encrypts files in the browser before upload and stores them for up to 24
hours, so it works when the receiver is offline. That is its advantage. The tradeoff is that the encrypted files
sit on a server for that period, and the service cannot be self-hosted. Its documentation does not state its account
model or save behaviour.

## Summary

Among these tools, none combines a two-way room with an exchange the server cannot read, and none documents checking
a pair of devices that the server introduced, as e2ft's same-network discovery does with its compared code.
WebWormhole applies a comparable exchange model to a one-shot transfer, PairDrop pairs devices across networks and
has public rooms, and Wormhole.app and transfer.zip work when the receiver is offline. e2ft is for two people who
are online together and want a session that either side can use.
