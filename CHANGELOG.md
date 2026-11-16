# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [SemVer](https://semver.org/): `0.MINOR.PATCH` until the first public release, which will be
`1.0.0`. A minor version adds a user-visible feature or breaks compatibility with the previous one (old invites or
an older peer stop working). A patch has only fixes.

## [Unreleased]

### Changed

- The server's source is grouped by feature: `src/signal/` (the relay, rooms, sockets, ICE), `src/web/` (assets
  and HTTP), `src/discover/` and `src/health/`, each beside a parent file of the same name. No behavior change.
- CI tests the server binary from the image build instead of compiling one per job, runs the end-to-end shards in
  Playwright's image, splits them by test time (`web/scripts/shard.mjs`), and runs every suite that needs a coturn in
  one job. Tests that need a coturn carry the `@turn` tag; set `E2E_SERVER` to run the e2e suite on a prebuilt server.

## [0.15.0] - 2026-11-15

### Added

- Transfer speed can show in bits per second (Mb/s) instead of bytes (MB/s): a Settings choice kept in this browser,
  also switched by clicking a transfer's progress text. In Russian the speed now reads in Russian units ("МБ/c")
  instead of ending in "/s".
- `ops/docker/docker-compose.yml` runs the app with its own coturn relay on one Linux host.
- A Helm chart in `ops/helm/e2ft/`, with an optional coturn on a node's network or behind a load balancer. Each
  release publishes it as an OCI chart next to the image.
- `e2ft --health` checks a running server and each TURN server it hands out (a signed allocation, freed at once), and
  the image declares it as its `HEALTHCHECK`, so `docker ps` shows a stopped coturn or a `TURN_SECRET` that differs
  from coturn's. The exit code tells which failed: 1 the server, 3 a TURN server, 4 the TURN credential.

### Changed

- The version at the bottom of the page links to its changelog on GitHub.
- A transfer's speed is the rate over the last 8 seconds, the same one its time left uses, instead of the average
  since the start, so it follows the transfer as it speeds up or slows down.
- CI runs the end-to-end tests as three parallel shards and lists each test's duration.
- The image builds on Node.js 26.13.0, Rust 1.99.1 and the current distroless base; sha1, hmac and md-5 moved to their
  digest 0.11 releases and TypeScript to 7.
- CI builds the image and runs the later stages for a change to the image's own files only; before, every stage
  after the skipped lint jobs was skipped too.
- The Dockerfile moved to `ops/docker/Dockerfile`; build with `-f ops/docker/Dockerfile` from the repository root.
- The tuning settings (`CHUNK_SIZE`, `WINDOW`, `KEEP_ALIVES`, `ACCESS_LEN` and the rest) are read when the server
  starts instead of when it is built, so the published image takes them as environment variables (`-e`, compose
  `environment`, the chart's new `extraEnv`). **Breaking for self-built images:** `--build-arg` values for them are
  now ignored; pass them to the running container. A bad value still stops the server, now at startup.
- `cargo build` no longer builds the frontend: run `npm run build` in `web/` first, or `npm run serve` there, which
  builds both and starts the server.
- CI runs each stage in its own workflow file, one job per tool, and skips the Rust or the frontend jobs when a
  change does not touch that side.

### Fixed

- A connection that dropped just as a chunk went out could end the room on the sending side instead of pausing the
  transfer for the reconnect.
- A browser that saves through its private storage (Firefox with Service Workers off) could decline a file offered in
  the first seconds after the page loaded, saying it can't save files.

## [0.14.9] - 2026-11-14

### Changed

- The README shows how to run a published release image.

## [0.14.8] - 2026-11-14

### Added

- Continuous integration on GitHub: every pull request and push to `main` runs the checks, the end-to-end and
  coturn-backed tests and the security scans. Each release tag publishes the image to the GitHub container registry.
- `CONTRIBUTING.md`: how to run the gate locally and how pull requests are merged.

## [0.14.7] - 2026-11-14

### Fixed

- An offered file name can no longer hide its real extension with right-to-left or other invisible characters;
  control, format and path characters are removed before the name is shown or saved.
- The peer can no longer choose the names of files kept in the browser's private storage, so it can't overwrite or
  delete a received file that has not been saved yet.
- A declined peer can't flood the screen with offers: for 5 seconds after a decline its offers are declined without
  a dialog. Persistent storage is asked for only after you accept a file.
- A dishonest server can no longer replay an earlier pairing into a room after a reconnect; the room ends instead.
- A discovery answer reaches only a device that asked, once per ask.
- A forwarded-address header with one invalid byte no longer hides the real client address behind it.

## [0.14.6] - 2026-11-14

### Fixed

- One client can no longer open discovery sockets without limit. Each client address may hold 32 at once, counted
  apart from room sockets; the page retries a refused one.

## [0.14.5] - 2026-11-14

### Fixed

- A few addresses can no longer hold every TURN relay port. The deployed relay now has 1000 ports instead of 100,
  and the server gives each client at most 30 TURN credentials at once, then one every 5 seconds. Over that, a
  pairing gets STUN only.

## [0.14.4] - 2026-11-13

### Fixed

- A client that creates and leaves rooms in a loop no longer grows the server's memory until it is killed. Rooms
  that time out are now ended by one task that checks every second, instead of a timer per room that stayed behind
  after the room was gone.

## [0.14.3] - 2026-11-13

### Fixed

- One client can no longer fill the server's room table and lock everyone else out of creating rooms. A client
  address may hold 16 live rooms it created (an IPv6 address counts by its /64, and one /48 holds 256 together); the
  next `create` gets `too-many`. A room counts until it ends, even while its creator is away. The environment
  setting `ROOMS_PER_CLIENT` changes the per-address number.

## [0.14.2] - 2026-11-13

### Added

- An integration test runs the server's own TURN credentials against a real coturn: both browsers relay through it
  and a file arrives intact, while a server signing with a different secret never connects. Run it with
  `web/scripts/coturn.sh start` and `npm run integration`. The end-to-end specs moved to `web/tests/e2e/`.

## [0.14.1] - 2026-11-13

### Fixed

- A relayed transfer started long after pairing uses several connections again. Each new connection asks the server
  for fresh TURN credentials, which now last 2 minutes instead of 10.

## [0.14.0] - 2026-11-13

### Added

- A room nobody joins is deleted after 15 minutes, and its creator sees that the invite expired. `ROOM_WAIT` sets
  the wait in seconds.
- The server holds at most 10 000 rooms and 16 open signalling sockets per network address, and each socket may
  relay only signalling-sized traffic. Each refusal has its own message on the page.
- Every response carries HSTS, `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that allows only
  the camera and the screen wake lock.

## [0.13.0] - 2026-11-13

### Fixed

- A device that leaves its network (for example Wi-Fi to mobile data) drops off the other devices' lists within
  about 15 seconds instead of up to 40.
- The device-list socket closes when a page sends its name or asks far too often, and a repeated hello with the same
  name no longer resends the list to every device.
- After you decline a device's ask, its further asks are declined quietly for 30 seconds instead of opening the
  dialog again.
- A page that accepted an ask but could not create the room no longer turns away other asks until it goes home.

### Changed

- **Breaking:** the protocol label in key derivation and the CPace channel identifier is `e2ft/v1`. Peers on older
  builds can no longer pair.

## [0.12.0] - 2026-11-13

### Changed

- Internal cleanup of names in code and docs. No behavior change.

## [0.11.0] - 2026-11-13

### Changed

- Internal cleanup of names in code and docs. No behavior change.

## [0.10.1] - 2026-11-10

### Changed

- Build housekeeping. No behavior change.

## [0.10.0] - 2026-11-10

### Added

- Same-network discovery, off by default. With "Visible to devices on my network" on in Settings, home pages behind
  the same public address list each other by a renamable device name and browser. A tap asks the other device; when
  it accepts, a room starts without an invite, both screens show the same 6-digit code, and the connection starts
  only after both people confirm it.
- `TRUSTED_PROXIES` (server environment): the reverse proxies whose `X-Forwarded-For` names the client, needed for
  discovery behind a proxy.
- Metric `e2ft_discoverable`: home pages visible to their network.

### Changed

- The room key exchange gained a mode for rooms without a secret: the creator commits to its public share before the
  joiner answers. Rooms from an invite are unchanged and stay compatible with 0.9.

## [0.9.1] - 2026-11-10

### Changed

- Comments, test names and docs tidied; `npm run check` gained a style scan for them. No behavior change.

## [0.9.0] - 2026-11-09

### Added

- Build-time settings: the transfer tuning (`CHUNK_SIZE`, `WINDOW`, `MAX_DIRECT` and the rest), the invite key
  lengths (`ACCESS_LEN`, `SECRET_LEN`) and the keep-alive choices (`KEEP_ALIVES`, `KEEP_ALIVE`) can be overridden by
  environment variables or Docker `--build-arg`s. Defaults are unchanged; a bad value fails the build with the
  variable's name. Builds with different key lengths or keep-alives cannot share invites.

## [0.8.0] - 2026-11-09

### Changed

- Branding moved from build time to runtime. The image is always the neutral app; `ASSETS_DIR` points the server
  at a folder whose `public/` files are served over the built-in ones and whose `slots/<name>.html` fill the page's
  slots. The server reads it once at startup and stops with a message if it is broken. Deployments that relied on
  a branded build must mount their folder before upgrading.
- The server writes the content stamps (`?v=`) and the version into the page at startup; the build no longer does.

## [0.7.6] - 2026-11-09

### Fixed

- A Firefox receiver whose download request skipped the Service Worker hung at 0
  after accepting. The page now notices within 5 seconds and saves the file through OPFS instead.

## [0.7.5] - 2026-11-09

### Added

- Public documentation: a new `README.md`, `docs/` (architecture, protocol, technologies, user flows, comparison
  with similar tools), `SECURITY.md` with the threat model, and the AGPL-3.0 `LICENSE`.

## [0.7.4] - 2026-11-09

### Changed

- Build housekeeping. No behavior change.

## [0.7.3] - 2026-11-09

### Changed

- The `Dockerfile` builds with or without a branding overlay.

## [0.7.2] - 2026-11-09

### Changed

- The Terms and Privacy pages open in the UI language for any language the overlay has pages for
  (`terms.<lang>.html`, `privacy.<lang>.html`), not only Russian; other languages get English.

## [0.7.1] - 2026-11-09

### Changed

- Frontend and server split further into one module per role: transfers per direction, the room as a class, one
  place for saved settings, and the server's config, HTTP, relay and metrics. No behavior change.
- Branding, legal pages and footer links come from an optional overlay; without it the app builds with a plain
  theme and no legal pages.
- The check gate runs from a fresh clone, with lint and format checks (oxlint, oxfmt).

## [0.7.0] - 2026-11-09

### Added

- A notification in a hidden tab when the other person joins or comes back after being away.
- The app version in the page footer, and an `e2ft_build_info{version}` gauge on `/metrics`.

### Changed

- Frontend code split into one module per role (UI by screen, crypto, network, transfer). No behavior change.

## [0.6.0] - 2026-11-07

### Changed

- **Breaking:** invite keys are short Crockford base32 strings, and a CPace key exchange turns them into the room
  key. Invites from 0.5.0 no longer work.

### Fixed

- A save that stalls during a network outage survives it (28 minutes for streamed downloads, 5 minutes for the other
  save paths).

## [0.5.0] - 2026-11-06

### Added

- File chunks spread over up to 4 adaptive data connections (8 when direct without TURN), shown per direction on the
  connection card.
- Time left on transfer progress rows.
- A transfer pauses when the connection drops and resumes after the reconnect.

### Changed

- **Breaking:** the room access key is 8 base64url characters. Older invites no longer work.

## [0.4.0] - 2026-11-06

### Added

- Control messages on their own data channel, with acknowledged progress on the sender's side.

### Changed

- **Breaking:** the invite fragment is shown as the secret key, and room settings travel in typed keys. Older invites
  and older peers no longer work.
- Room screen polish: Use TURN on the Join screen, the transfer beam starts after accept, connection info stays while
  sending, the away countdown reads MM:SS.
- Fun mode is on by default; its toggle became "Disable animations".

### Fixed

- Firefox ends the room on close, so the other side sees "peer left".

## [0.3.0] - 2026-11-06

### Added

- Prometheus metrics on a separate port.
- Fun mode animations: room presence, file flow, a lightning transfer bar with a spell beam.
- "Always use TURN" setting, and a warning before relaying through the creator's TURN server.
- The invite hides once the peer joins or the room ends.
- A clear message when a configured TURN server gives no relay, and relay-only rooms end after 10 s without one.
- Terms of Service and Privacy Policy pages.
- Optional notifications for offers and finished transfers in a background tab.
- A confirm screen before joining that shows the creator's non-default room settings.

## [0.2.0] - 2026-11-05

### Added

- TURN credentials, a container image and CI.
- Light and dark themes, English and Russian UI.
- Rooms stay alive while one side is away, and that side can rejoin.
- Settings for an own TURN server and the keep-alive, and custom rooms with forced relay (optionally over TCP).
- The invite as a QR code, with a scanner on mobile.
- Connection information in the room header.
- Asset URLs stamped with content hashes.

## [0.1.0] - 2026-11-05

### Added

- Encrypted two-person rooms with P2P file transfer over WebRTC, run locally.
- Streamed downloads in Firefox, cancel and progress.
