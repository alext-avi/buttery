#!/usr/bin/env bash
# GitHub runner entrypoint. The host owns its runtime env and HTTPS ingress.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DEPLOY_HOST:?Set the demo environment DEPLOY_HOST variable}"
: "${DEPLOY_USER:?Set the demo environment DEPLOY_USER variable}"
: "${DEPLOY_SSH_KEY:?Set the demo environment DEPLOY_SSH_KEY secret}"
: "${DEPLOY_KNOWN_HOSTS:?Set the verified DEPLOY_KNOWN_HOSTS secret}"
: "${DEMO_URL:?Set the demo environment DEMO_URL variable}"
: "${RELEASE_IMAGE:?Expected a registry image pinned by digest}"
: "${GHCR_USER:?Set GHCR_USER}"
: "${GHCR_TOKEN:?Set the short-lived GHCR token}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/buttery}"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-/opt/buttery/.env.demo}"
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$DEPLOY_PORT" =~ ^[0-9]+$ ]] || { echo 'Invalid SSH target' >&2; exit 2; }
[[ "$DEPLOY_DIR" =~ ^/[a-zA-Z0-9_/-]+$ && "$DEPLOY_ENV_FILE" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Use absolute deployment paths without spaces or shell characters' >&2; exit 2; }
[[ "$RELEASE_IMAGE" =~ ^ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$ && "$GHCR_USER" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid release image or registry user' >&2; exit 2; }
[[ "$DEMO_URL" == https://* ]] || { echo 'The remote demo URL must use HTTPS' >&2; exit 2; }
umask 077
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$TEMP/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$TEMP/known_hosts"
SSH=(ssh -i "$TEMP/key" -p "$DEPLOY_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$TEMP/known_hosts" -o ConnectTimeout=15 "$DEPLOY_USER@$DEPLOY_HOST")
# Install only the release runner and Compose definition; never copy the local .env.
"${SSH[@]}" "test -d '$DEPLOY_DIR' && test -r '$DEPLOY_ENV_FILE' && command -v docker >/dev/null && command -v python3 >/dev/null && command -v flock >/dev/null"
tar -C "$ROOT" -cf "$TEMP/deploy.tar" scripts/promote-demo.sh scripts/receive-demo.sh deploy/demo/compose.yaml
"${SSH[@]}" "mkdir -p '$DEPLOY_DIR/.local/incoming' && cat > '$DEPLOY_DIR/.local/incoming/deploy.tar'" < "$TEMP/deploy.tar"
# The token travels on stdin to a temporary Docker config, removed on exit.
printf '%s\n' "$GHCR_TOKEN" | "${SSH[@]}" "tar -xf '$DEPLOY_DIR/.local/incoming/deploy.tar' -C '$DEPLOY_DIR' && bash '$DEPLOY_DIR/scripts/receive-demo.sh' '$RELEASE_IMAGE' '$GHCR_USER' '$DEPLOY_ENV_FILE'"
node "$ROOT/scripts/smoke-demo.mjs" "$DEMO_URL"
