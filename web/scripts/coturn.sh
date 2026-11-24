#!/usr/bin/env bash
# Loopback coturns for the relay tests: `coturn.sh start` before them, `coturn.sh stop` after.
#   3479, 3480  static users (OWN_TURN, JOINER_TURN in tests/e2e/fixtures.ts) for the E2E_TURN=1 specs
#   3481        shared secret (E2E_TURN_SECRET), the scheme the server signs TURN credentials with, for npm run integration
# Uses `turnserver` when it is installed (CI), otherwise the pinned coturn image in podman on the host network.
# Every value here is a test value for a coturn that listens on 127.0.0.1 only.
set -euo pipefail

IMAGE=docker.io/coturn/coturn:4.19.1
SECRET=${E2E_TURN_SECRET:-e2e-loopback-turn-secret-0123456789}
STATE=${TMPDIR:-/tmp}/e2ft-coturn

# name, then that coturn's own flags
SERVERS=(
  "own --listening-port=3479 --min-port=49160 --max-port=49200 --lt-cred-mech --user=e2e-turn-user:e2e-turn-cred-7Qx"
  "joiner --listening-port=3480 --min-port=49201 --max-port=49240 --lt-cred-mech --user=e2e-joiner-user:e2e-joiner-cred-9Lp"
  "server --listening-port=3481 --min-port=49241 --max-port=49280 --use-auth-secret --static-auth-secret=$SECRET"
)
COMMON="-n --no-cli --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --realm=e2e --allow-loopback-peers"

start() {
  mkdir -p "$STATE"
  for entry in "${SERVERS[@]}"; do
    read -r name flags <<< "$entry"
    # shellcheck disable=SC2086 # the flags are meant to split
    if command -v turnserver > /dev/null; then
      turnserver $COMMON $flags --log-file="$STATE/$name.log" --simple-log > /dev/null 2>&1 &
      echo $! > "$STATE/$name.pid"
    else
      podman run -d --rm --name "e2ft-e2e-turn-$name" --network host "$IMAGE" $COMMON $flags > /dev/null
    fi
  done
  for port in 3479 3480 3481; do
    for _ in $(seq 50); do
      (exec 3<> "/dev/tcp/127.0.0.1/$port") 2> /dev/null && continue 2
      sleep 0.1
    done
    echo "coturn on $port did not start; logs in $STATE or podman logs" >&2
    exit 1
  done
}

stop() {
  for entry in "${SERVERS[@]}"; do
    read -r name _ <<< "$entry"
    if [[ -f "$STATE/$name.pid" ]]; then
      kill "$(cat "$STATE/$name.pid")" 2> /dev/null || true
      rm -f "$STATE/$name.pid"
    else
      podman stop -i "e2ft-e2e-turn-$name" > /dev/null 2>&1 || true
    fi
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
