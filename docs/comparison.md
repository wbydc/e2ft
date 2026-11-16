# How e2ft compares

This page compares e2ft 0.15 with five other browser file transfer tools: PairDrop, FilePizza, WebWormhole,
transfer.zip and Wormhole.app. It is based on each project's own documentation as of 2026-11-16, with GitHub stars
from the GitHub API that day. Each tool's section describes it, then lists where it falls short of e2ft. "Not
documented" marks something the project does not state, so check it before you rely on it.

| Project | Direction | Both online | Secret path | Server can read or MITM? | Files stored server-side | Save-location picker | Self-hosting | License | Stars |
|---|---|---|---|---|---|---|---|---|---|
| e2ft | Two-way room; either side sends | Yes | Secret in the URL fragment, used in CPace; never sent | No; sealed signalling fails if altered | No | Yes on Chromium; streamed download or OPFS elsewhere | Yes: image, Compose file with coturn, Helm chart | AGPL-3.0 | new |
| PairDrop | Either side, within a network, pair or public room | Yes | Room or pairing code goes to the server | Yes; DTLS only, the server relays the fingerprints | No; TURN relay for paired devices behind NAT | No; auto-download, several files as a ZIP | Yes | GPL-3.0 | 11.8k |
| FilePizza | One-way, uploader to downloaders | Yes; the uploader keeps the window open | Channel id in the link goes to the server | Yes; DTLS only, optional password | No | No; streamed download, several files as a ZIP | Yes | BSD-3-Clause | 10.3k |
| WebWormhole | One-way, one transfer | Yes | One-time code is a CPace password; never sent | No; the PAKE authenticates the exchange | No | No | Yes | BSD-3-Clause | 2.1k |
| transfer.zip | One-way link | Quick Transfers: yes; Stored Transfers: no | Full 256-bit AES-GCM key in the link or QR code | Reads no file data; the handshake is not keyed; relays all files over 10 MB | Stored Transfers: yes, until expiry | Not documented | Yes; the self-hosted branch can lag production | AGPL-3.0 | 1.5k |
| Wormhole.app | One-way link | No up to 5 GB; yes above | 128-bit AES-GCM key in the link fragment | No for file content | Yes, up to 5 GB for 24 hours | Not documented | No | Proprietary; only the crypto library is open | n/a |

## e2ft

e2ft gives two people one room in which either side can send, with a secret that never reaches the server, no files
on the server, and a save-location picker where the browser offers one. CPace turns the secret into the room key,
so the server can neither read the signalling nor swap in its own keys without the exchange failing. Each chunk is
sealed with AES-GCM on top of WebRTC's own encryption. Devices behind one public address can also find each other,
off by default: both screens show a 6-digit code derived from the key exchange, and nothing connects until both
people confirm it matches. Self-hosting takes one container image, a Docker Compose file that brings its own coturn
relay, or a Helm chart.

## [PairDrop](https://github.com/schlagmichdoch/PairDrop)

PairDrop is the closest tool in scope: AirDrop-style sharing in the browser, a fork of Snapdrop. Devices on the same
network see each other without an invite. Devices can also be paired with a 6-digit code or QR code, and paired
devices find each other on any network, even after PairDrop is reopened. Temporary public rooms, joined with a
5-letter code, connect people over the internet. Either side can send; a transfer starts once the receiver accepts
it. It can also send text, and from the share menu on Android and iOS, the context menu on Windows and Ubuntu, or a
command line.

Where it falls short:

- The server is a trust anchor. Room and pairing codes go to it, and it relays the WebRTC handshake, including the
  DTLS fingerprints, so a malicious or compromised server can swap them and read every file in transit.
- Files get no encryption of their own beyond DTLS. Between paired devices behind NAT they all flow through the
  PairDrop TURN server, protected only by that server-relayed handshake. A self-hosted instance can also turn on a
  WebSocket fallback that sends files through the server itself.
- Everyone in a public room sees everyone else, and the room is gated only by its 5-letter code.
- There is no save-location picker: files download automatically, and several arrive as one ZIP.

## [FilePizza](https://github.com/kern/filepizza)

FilePizza turns an upload into a link. The uploader picks files, shares a short or long URL, and keeps the page open
while receivers download straight from their browser over WebRTC, with nothing stored on a server. Any number of
people can download from one link, the uploader sees their progress and can stop a transfer, and receivers stream
the file through a Service Worker without holding it in memory. An optional password adds a check, and several files
arrive as one ZIP.

Where it falls short:

- Transfers go one way. The receiver cannot send anything back without starting a new upload.
- Closing the uploader's window kills the link for anyone who has not finished.
- Security rests on WebRTC's DTLS, set up through a signalling server that must be trusted. Without the optional
  password, the link alone lets anyone download, so a leaked link leaks the files.
- Signalling runs over PeerJS, and a self-hosted instance uses the public PeerJS server at `0.peerjs.com` unless you
  configure your own.
- There is no save-location picker.

## [WebWormhole](https://github.com/saljam/webwormhole)

WebWormhole uses the same core idea as e2ft: a one-time code is a CPace password, and the key exchange authenticates
the relayed session descriptions with their DTLS fingerprints, so the signalling server cannot read or alter the
exchange. It is modelled on Magic Wormhole, sends files or other data from one computer to another, and works from
the browser, a browser extension that loads no remote code, or a command-line tool.

Where it falls short:

- Its own README warns that it is in early development, uses experimental cryptographic libraries and has had no
  security or cryptography review.
- The repository has had no commits since 2025-12-22.
- It moves one transfer, one way. There is no room to send more files or reply.
- The hosted signalling and relay servers come with no guarantee of uptime.
- There is no save-location picker.

## [transfer.zip](https://github.com/robinkarlberg/transfer.zip-web)

transfer.zip is a self-hostable alternative to WeTransfer with two modes. Quick Transfers stream a file over WebRTC,
sealed with AES-GCM under a random 256-bit key carried in the link or QR code, while both people are online. Stored
Transfers upload the file to the server or S3 storage with resumable uploads, so the receiver can download later.
It also offers transfer requests, custom branding and email notices.

Where it falls short:

- The link carries the full encryption key, so anyone who sees the link or its QR code can read the file. The key
  does not authenticate the handshake.
- Every Quick Transfer over 10 MB is forced through the signalling server as a relay, even when a direct WebRTC
  connection works. The server carries all the encrypted bytes and can see their size and timing.
- Stored Transfers keep the file on the server or in S3 storage until it expires.
- Transfers go one way.
- Its README lists known problems: 0-byte files get stuck in Quick Transfers, sending from Firefox on mobile does not
  work, and sending from some Safari versions is buggy.
- The self-hosted `main` branch can lag behind the code that runs in production.

## [Wormhole.app](https://wormhole.app)

Wormhole.app is a hosted service for sending files by link. It encrypts files in the browser with AES-GCM before
they leave, keeps the key in the link's fragment so the server never receives it, and uploads files up to 5 GB to
its servers for 24 hours, so the receiver can download after the sender has closed the page. Larger files go
peer-to-peer over WebRTC.

Where it falls short:

- It is a closed service. Only its encryption library is open source, and it cannot be self-hosted, so you have to
  trust the code it serves with no way to run your own.
- Files up to 5 GB sit on its servers for 24 hours, encrypted.
- Above 5 GB the sender must keep the page open until the receiver downloads.
- The link carries the 128-bit key, so anyone who sees the link can read the files.
- A link sends files from its creator to its receivers; its documentation describes no way to reply.

## Summary

None of the other five combines a two-way room with an exchange the server cannot read. PairDrop and FilePizza trust
their server with the handshake, transfer.zip and Wormhole.app put the whole key in the link, and transfer.zip and
Wormhole.app also store or relay the files on their servers. WebWormhole shares e2ft's exchange model but is
unreviewed and moves one transfer. None checks a pair of devices the server introduced, as e2ft's discovery does with
its compared code, and none documents a save-location picker. e2ft is for two people who are online together and
want a private session either side can use.
