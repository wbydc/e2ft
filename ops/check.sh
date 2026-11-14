#!/usr/bin/env bash
# Checks the self-hosting kits: the Helm chart renders and validates in each coturn mode, and the compose file
# resolves. Needs helm and docker (or podman, via CONTAINER=podman). Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER=${CONTAINER:-docker}
KUBECONFORM=ghcr.io/yannh/kubeconform:v0.8.0
# A dummy value of the required length; nothing here runs a server.
SECRET=check-only-secret-0123456789abcdef

declare -A MODES=(
  [no-coturn]=""
  [host-network]="--set coturn.enabled=true,coturn.host=turn.example.com,coturn.listeningIp=203.0.113.7,turn.secret=$SECRET"
  [load-balancer]="--set coturn.enabled=true,coturn.mode=loadBalancer,coturn.host=turn.example.com,coturn.externalIp=203.0.113.9,turn.existingSecret=e2ft-turn,ingress.enabled=true,metrics.enabled=true"
)

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

for mode in "${!MODES[@]}"; do
  # shellcheck disable=SC2086 # the flags are meant to split
  helm lint --strict helm/e2ft ${MODES[$mode]}
  # shellcheck disable=SC2086
  helm template e2ft helm/e2ft ${MODES[$mode]} > "$out/$mode.yaml"
done
"$CONTAINER" run --rm -v "$out:/manifests:ro" "$KUBECONFORM" -strict -summary /manifests

TURN_HOST=turn.example.com TURN_SECRET=$SECRET "$CONTAINER" compose -f docker/docker-compose.yml config --quiet
if (unset TURN_SECRET; TURN_HOST=turn.example.com "$CONTAINER" compose -f docker/docker-compose.yml config --quiet 2> /dev/null); then
  echo "compose started without TURN_SECRET" >&2
  exit 1
fi
# One coturn version everywhere: an update to one pin (Dependabot reads only the compose file) must move them all.
coturn=$(grep -ho 'coturn/coturn:[^" ]*' docker/docker-compose.yml helm/e2ft/values.yaml ../web/scripts/coturn.sh | sort -u)
if [ "$(printf '%s\n' "$coturn" | wc -l)" -ne 1 ]; then
  printf 'coturn versions differ between the compose file, the chart and web/scripts/coturn.sh:\n%s\n' "$coturn" >&2
  exit 1
fi
echo "ops ok"
