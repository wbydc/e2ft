# e2ft

Share files between two browsers. There are no accounts. Files go from browser to browser, end to end encrypted
with a short secret that the server never sees. Nothing is stored on the server.

## How it works

1. One person opens the site and creates a room. The page shows an invite link of the form
   `/r/<accessKey>#<config><secret>`.
2. The invite goes to the other person by any channel. When they open it, the two browsers connect through the
   server's WebSocket relay and run CPace (draft-irtf-cfrg-cpace-21) with the secret as the password
   (`web/src/crypto/key-exchange.ts`). Both sides confirm the exchange before any WebRTC offer or answer is sent.
3. Either side chooses a file. The other side accepts or declines, then chooses where to save it. File data goes
   over WebRTC DataChannels and is encrypted chunk by chunk (`web/src/transfer/outgoing.ts`).

Two devices on the same network can skip the invite. With "Visible to devices on my network" turned on in Settings
(off by default), each sees the other on the home page and starts a room with a tap. There is no secret then, so both
screens show a 6-digit code derived from the key exchange, and nothing connects until both people confirm that the
codes match (`web/src/net/signal.ts`, `docs/protocol.md`).

If the browsers cannot reach each other directly, they can use a configured TURN relay. The relay forwards
encrypted packets and cannot read them, but it does see the two IP addresses. Rooms live in the server's memory
(`src/signal/rooms.rs`). A room is deleted when either side leaves, or after its keep-alive runs out. The keep-alive is 5
minutes by default and can be set to Off, 1, 5, 15 or 30 minutes.

What the server sees:

- The room's access key and the two WebSocket connections, including client IP addresses while the connections are
  open.
- It does not see the secret. The secret is in the URL fragment, which browsers do not send in an HTTP request. A
  joiner's page removes it from the address bar and history on load.
- It does not see file names, types, or contents in clear, and it does not see the WebRTC handshake. The metadata
  and the handshake travel in messages encrypted with keys derived from the secret (`web/src/crypto/keys.ts`,
  `web/src/crypto/sealer.ts`). The server can see how much encrypted traffic a room carries.
- With discovery turned on, it sees the device name and browser label a page shows, and which visible pages share a
  public address. It keeps that address only as a keyed hash in memory while the page is open.
- It keeps no logs and writes nothing to disk. It can refuse or drop a connection, but it cannot read or alter the
  exchange without the connection failing.

The access key is an 8-character room id. The secret is 6 characters. The 2 characters before it in the fragment
encode the creator's room settings (keep-alive, connection mode, shared TURN). The joiner treats them as hints, not
as trusted input.

## Features

- Two people in one room. Either side can send. One transfer runs in each direction at a time, and both directions
  can run at once.
- End-to-end encryption with a short secret. The server cannot read the signalling or the files.
- No accounts, no server-side storage, and no logs.
- An invite link, a QR code, and a camera scanner for the QR code.
- Optional same-network discovery: two devices behind one public address that both turned it on see each other on
  the home page and start a room with a tap, then compare a 6-digit code on both screens. Off by default.
- The save-location picker in Chromium-based browsers. Firefox and Safari get a streamed download through a Service
  Worker (`web/public/sw.js`). Other cases fall back to origin private file storage (OPFS), and iOS holds the file
  until the user taps Save (`web/src/transfer/save.ts`).
- A transfer pauses when the connection drops and resumes after the reconnect while the room lives.
- Chunks spread over several WebRTC connections when that improves throughput.
- Cancel from either side, progress with rate and time left, and a list of finished transfers for the room.
- Your own TURN server, sharing that server with the other person, an always-on relay option, and rooms forced to
  relay only or relay over TCP.
- Keep-alive of Off, 1, 5, 15 or 30 minutes.
- English and Russian UI, system, light or dark theme, optional animations, optional system notifications, and
  transfer speed in bytes or bits per second.
- Optional Prometheus metrics on a separate address.

## Requirements

- Rust 1.85 or newer. The crate uses edition 2024. The container image builds with Rust 1.99.1.
- Node.js 24 or newer to build the frontend, which `cargo build` embeds from `web/dist`. The image pins Node 26.13.0.
- Chromium and Firefox are the tested browsers; the end-to-end suite runs both. Safari and iOS use fallback save
  paths but are not covered by the automated tests.
- A TURN server if the two networks cannot connect directly.

## Quick start

Run the published image:

```bash
podman run --rm -p 8080:8080 ghcr.io/wbydc/e2ft:latest
```

Or build and run from source:

```bash
npm --prefix web ci && npm --prefix web run serve
```

`npm run serve` builds the frontend into `web/dist`, then runs `cargo run`, which embeds it in the binary. Arguments
after `--` go to cargo, as in `npm run serve -- --release`. After a frontend change, build it again before cargo:
`cargo run` alone embeds whatever `web/dist` holds. Open <http://127.0.0.1:8080> in two browser windows to test a
transfer.

To let other devices on the network reach the server:

```bash
ADDR=0.0.0.0:8080 npm --prefix web run serve
```

The default STUN server is Google's public server. Set `STUN_URLS=` (empty) to disable STUN. To force this
browser through the relay, add `?relay=1` to the page URL.

## Self-hosting

### Build and run

```bash
podman build --format docker -f ops/docker/Dockerfile -t e2ft .
podman run --rm -p 8080:8080 e2ft
```

Or run a published release: each release tag publishes the same image to the GitHub container registry, tagged
with the version and `latest`:

```bash
podman run --rm -p 8080:8080 ghcr.io/wbydc/e2ft:<version>
```

`docker build` and `docker run` work the same way. The image listens on `0.0.0.0:8080` and runs as a nonroot user.
Open <http://localhost:8080>.

The image declares a health check: every 30 seconds `/e2ft --health` asks the server for its page, then makes and at
once frees one allocation on each TURN server in `TURN_URLS` with a credential signed from `TURN_SECRET`. It fails
when the server does not answer, a TURN server is down, or its secret differs from coturn's, and prints the failed
step (`docker inspect --format '{{json .State.Health}}' <container>`). Its exit code tells which:

| Code | Meaning |
|---|---|
| 0 | Healthy |
| 1 | The server does not answer on `ADDR` |
| 3 | A TURN server is unreachable, does not answer or fails a step, or `TURN_URLS` is wrong |
| 4 | coturn rejected the credential: `TURN_SECRET` differs from coturn's |

Any code but 0 marks the container unhealthy; 2 is reserved by Docker. Docker's health log keeps the code, podman's
records every failure as 1 (run `podman exec <container> /e2ft --health` to see it). Podman keeps the health check only in images
built with `--format docker`, as above. The check reaches TURN from inside the container: when the TURN host's public
address is not reachable from there (a router without hairpin NAT, rootless podman), make its name resolve to the
host inside the container, for example `extra_hosts: ["turn.example.com:host-gateway"]`; the compose file below does
this. Keep `TURN_URLS` public, since browsers get the same list.

Rooms exist only in the memory of the process that created them. Run one instance, since a restart ends the open
rooms and a second instance would not see the first one's rooms.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ADDR` | `127.0.0.1:8080` (the image sets `0.0.0.0:8080`) | Listen address for the public server. |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs. Empty means no STUN. |
| `TURN_URLS` | empty | Comma-separated TURN URLs. Empty disables TURN. |
| `TURN_SECRET` | unset | The coturn `static-auth-secret`. Required when `TURN_URLS` is set, and at least 32 characters. |
| `METRICS` | `false` | `true` serves Prometheus metrics; any value other than `true` or `false` stops the server at startup. |
| `METRICS_ADDR` | `127.0.0.1:9090` | Listen address for `/metrics` when `METRICS=true`. The public address never serves it. |
| `ASSETS_DIR` | unset | A branding folder served over the built-in files (see Branding). Unset serves the neutral app. |
| `TRUSTED_PROXIES` | empty | Addresses or CIDR blocks of your reverse proxies, comma-separated. Needed for same-network discovery behind a proxy (see Reverse proxy). A bad entry stops the server at startup. |

The settings are read by `src/config.rs` and `src/signal/ice.rs`.

### Tuning settings

The transfer tuning, the invite key lengths and the keep-alive choices are read from the environment when the server
starts, like the settings above. The server checks them and hands them to the page, so one image serves any values.
A value that is not a number, is out of bounds or does not fit with another setting stops the server with a message
naming the variable.

```bash
CHUNK_SIZE=131072 npm --prefix web run serve
podman run --rm -p 8080:8080 -e CHUNK_SIZE=131072 -e KEEP_ALIVES=0,120,600 -e KEEP_ALIVE=120 ghcr.io/wbydc/e2ft:latest
```

In the compose file they go under the `e2ft` service's `environment`; in the Helm chart, in `extraEnv`. To keep
overrides in a file for local runs, put `NAME=value` lines in a `.env` at the repo root (it is gitignored) and load
it into the shell: `set -a; . ./.env; set +a`. The server does not read `.env` itself.

| Variable | Default | Bounds | Meaning |
|---|---|---|---|
| `CHUNK_SIZE` | `65536` | 1024 to 262120 | Plaintext bytes per encrypted chunk. A chunk's frame must fit in one 256 KiB data channel message. |
| `WINDOW` | `1024` | 16 to 65536 | Chunks the sender may run ahead of the receiver's acks. `WINDOW * CHUNK_SIZE` is at most 256 MiB. |
| `MAX_DIRECT` | `8` | 1 to 16 | Peer connections per direction when the main connection is direct. |
| `TURN_QUOTA` | `12` | 1 to 100 | TURN allocations per username; match coturn's `user-quota`. |
| `BUFFER_HIGH` | `8388608` | 64 KiB to 64 MiB | Queued bytes on a channel that pause the sender. |
| `BUFFER_LOW` | `1048576` | 0 to 64 MiB | Queued bytes below which the sender resumes. Below `BUFFER_HIGH`. |
| `STEP_MS` | `3000` | 500 to 60000 | How long each step of adding connections measures the rate. |
| `GAIN` | `1.2` | above 1, up to 4 | The rate gain a new connection must bring to stay. |
| `LANE_OPEN_MS` | `10000` | 1000 to 120000 | How long an extra connection may take to open. |
| `ACK_EVERY` | `32` | 1 to `WINDOW` | The receiver acks after this many written chunks. |
| `ACK_MS` | `500` | 50 to 10000 | Or after this many milliseconds. |
| `ACCESS_LEN` | `8` | 6 to 16 | Characters in the access key (the room id). The server checks it too. |
| `SECRET_LEN` | `6` | 6 to 16 | Characters in the secret, the password of the key exchange. |
| `KEEP_ALIVES` | `0,60,300,900,1800` | each 0 to 7200, ascending, at most 8 | The keep-alive choices in seconds. The server accepts only these. |
| `KEEP_ALIVE` | `300` | one of `KEEP_ALIVES` | The default keep-alive. |

Servers with different `ACCESS_LEN`, `SECRET_LEN`, `KEEP_ALIVES` or `KEEP_ALIVE` cannot read each other's invites;
during a rolling update that changes them, an invite made on an old instance may fail on a new one. A page loaded
before a restart keeps the values it was served with until it reloads. The values are in the public page, so never
put a secret in them.

### TURN relay

The server sends each peer short-lived TURN credentials in coturn's REST shared-secret mode: the username is an
expiry timestamp and the credential is a base64-encoded HMAC-SHA1 of that timestamp with the shared secret. The
credentials are valid for 2 minutes. An open relayed connection outlives them, and the browser asks for fresh ones
before opening extra transfer connections. Each client gets at most 30 credentials at once, then one every
5 seconds.

coturn keeps an allocation alive for as long as its holder refreshes it, and anyone can pair two of their own tabs
to get credentials. Give coturn a wide relay port range and a matching `total-quota`, and cap concurrent flows per
source address in the host firewall, so a few addresses can't hold every relay port.

An example `turnserver.conf` for coturn:

```ini
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<a-random-secret-of-at-least-32-characters>
realm=turn.example.com
min-port=49152
max-port=50151
total-quota=1000
no-cli
```

Open UDP and TCP port 3478 and UDP ports 49152 to 50151 in the firewall. If coturn is behind NAT, also set
`external-ip` to its public address.

Start e2ft with the same secret and the matching URLs:

```bash
podman run --rm -p 8080:8080 \
  -e TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp' \
  -e TURN_SECRET='<the-same-secret>' \
  -e STUN_URLS='stun:turn.example.com:3478' \
  e2ft
```

For `turns:`, enable TLS in coturn, usually on port 5349 with a certificate, and use
`turns:turn.example.com:5349` in `TURN_URLS`.

### Docker Compose

`ops/docker/` runs the app and its own coturn on one Linux host:

```bash
cd ops/docker
cp .env.example .env   # set TURN_HOST and TURN_SECRET
docker compose up -d
```

Compose refuses to start without `TURN_SECRET` and `TURN_HOST`. It runs the release image of this checkout's version
from `ghcr.io/wbydc/e2ft`; to run your own build, build it (see Build and run) and set `E2FT_IMAGE` in `.env`. coturn
runs on the host network, because relay addresses must be the host's own, so this works on Linux and not on Docker
Desktop. Its settings are in `ops/docker/turnserver.conf`; the secret and realm are added in memory when it starts and
never appear in a command line. A STUN request checks coturn's health every 30 seconds, and the app's own check (above) also
makes a TURN allocation with the shared secret, so `docker compose ps` shows a stopped coturn or a mismatched secret. Open the
TURN ports above in the firewall. The app listens on `127.0.0.1:8080`; put a TLS reverse proxy in front of it (below).
`podman compose` works the same way. With rootless podman, set `TURN_HOST` to a DNS name rather than an IP address:
the container sees the host's own address as its own, so the app's health check reaches coturn only through the name,
which compose points at the host.

### Kubernetes (Helm)

`ops/helm/e2ft/` is a Helm chart, published with every release as `oci://ghcr.io/wbydc/charts/e2ft`:

```bash
helm install e2ft oci://ghcr.io/wbydc/charts/e2ft --version <version> \
  --set ingress.enabled=true,ingress.host=e2ft.example.com,ingress.tlsSecretName=e2ft-tls \
  --set coturn.enabled=true,coturn.host=turn.example.com,turn.existingSecret=e2ft-turn \
  --set coturn.nodeSelector."kubernetes\.io/hostname"=<node>
```

The app runs as one replica with the `Recreate` strategy. `turn.existingSecret` names a Secret whose `secret` key
holds the TURN shared secret (`turn.secret` makes one for you). coturn is off by default and has two modes:

- `coturn.mode=hostNetwork` (default) runs coturn on the network of the node `coturn.nodeSelector` picks. Point
  `coturn.host` at that node's public address, and set `coturn.externalIp` if the node is behind NAT.
- `coturn.mode=loadBalancer` puts coturn behind a `LoadBalancer` Service with `externalTrafficPolicy: Local`, which
  keeps client addresses. Set `coturn.externalIp` to the load balancer's address. The Service has one port per relay
  port, so narrow `coturn.minPort` and `coturn.maxPort` if your load balancer limits listeners.

Without coturn, `turn.urls` points the app at a TURN server you run elsewhere. Set `trustedProxies` to your ingress
controller's pod addresses for same-network discovery, and `assets.configMap` for branding. `values.yaml` lists
every setting. The chart runs `ghcr.io/wbydc/e2ft` at the chart's version; `image.repository` and `image.tag` run
your own build.

### Reverse proxy

Proxy HTTP and WebSocket traffic to the app. `/ws` needs the WebSocket upgrade headers. An nginx example:

```nginx
server {
    listen 443 ssl;
    server_name e2ft.example.com;

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    location /discover {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}
```

Same-network discovery groups browsers by their public address, so behind a proxy the app must learn it. Set
`TRUSTED_PROXIES` to the proxy's address as the app sees it (`127.0.0.1` for the example above) and make the proxy
set `X-Forwarded-For` itself, as the `/discover` block does. Without `TRUSTED_PROXIES` every browser appears to come
from the proxy; a private or loopback proxy address then forms no group and discovery shows no devices, which is the
safe failure. Do not let the proxy pass on an `X-Forwarded-For` that a client sent: that client could then place
itself in another address's group. Browsers that reach the app with private addresses (a server on your own LAN with
no proxy) are not grouped.

### Branding

The image and the build are unbranded. To restyle a running instance, mount a folder and point `ASSETS_DIR` at it;
no rebuild is needed. The server reads the folder once at startup, so restart it after a change.

- `public/`: files served over the built-in ones at the same path. Replace `ui/tokens.css` (colors, sizes, fonts) and
  `ui/components.css` to restyle the app, and add fonts, logos or anything the slots reference. `terms.html` and
  `privacy.html` turn on the `/terms` and `/privacy` routes; `terms.<lang>.html` serves `/terms?lang=<lang>`.
- `slots/<name>.html`: markup that replaces the default between `<!-- slot:<name> -->` and `<!-- /slot:<name> -->`
  in `web/public/index.html`. The slots are `head` (theme colors, favicon, font stylesheets), `home` (the logo and
  name in the header), `legal-note` (a line under Create Room) and `footer` (links beside the version).

Every local `src` and `href` in the page gets the content stamp of the file it names, including files from the
folder. The server stops at startup with a message if the folder is missing or unreadable, or if a slot file names
a slot the page does not have. The folder is styling and markup only; scripts cannot be replaced.
`web/tests/assets/` is a small example:

```bash
ASSETS_DIR=web/tests/assets npm --prefix web run serve
podman run -v ./my-brand:/assets:ro -e ASSETS_DIR=/assets e2ft
```

## Development

```bash
cargo test
cd web && npm ci && npm run check
cd web && npm run e2e
```

- `cargo test` runs the room rules and statistics, TURN credential generation, the served files with their stamps
  and slots, the legal pages, the metrics text, and the WebSocket hello checks.
- `npm run check` runs the TypeScript type check, the formatting check, the linter, the project style checks, and
  the unit tests.
- `npm run e2e` runs Playwright with Chromium and Firefox and starts a release build of the server itself. The
  default port is 18080; `E2E_PORT=18081` picks another one. `E2E_SIZE_MB=2048` sets the transferred file size. For
  large runs, point `TMPDIR` at a disk path.
- `npm run fmt` formats the frontend, and `npm run lint` runs the linter alone.

See `CONTRIBUTING.md` before opening a pull request. CI runs the same gate, plus the coturn-backed tests and
security scans, on every pull request and push to `main`.

## Documentation

- [Architecture](docs/architecture.md): the parts, key derivation, saving paths, reconnect, and lanes.
- [Protocol](docs/protocol.md): the WebSocket and DataChannel messages.
- [Technologies](docs/technologies.md): the stack and its libraries.
- [User flows](docs/user-flows.md): what each screen does.
- [Comparison](docs/comparison.md): how e2ft compares with other browser file transfer tools.
- [Security policy](SECURITY.md): how to report a vulnerability.

## License

e2ft is free software under the GNU Affero General Public License, version 3.0. See [LICENSE](LICENSE).
