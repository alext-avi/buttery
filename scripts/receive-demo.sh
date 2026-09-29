#!/usr/bin/env bash
# Runs on the Vultr host. Registry password arrives only over stdin.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:?Digest-pinned image required}"
REGISTRY_USER="${2:?Registry user required}"
ENV_FILE="${3:?Private demo env file required}"
[[ "$IMAGE" =~ ^ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$ ]] || exit 2
umask 077
mkdir -p "$ROOT/.local"
exec 9> "$ROOT/.local/deploy.lock"
flock -w 600 9
REGISTRY_CONFIG="$(mktemp -d)"
trap 'rm -rf "$REGISTRY_CONFIG"' EXIT
# Keep the normal Docker context. --config applies only to these registry operations.
docker --config "$REGISTRY_CONFIG" login ghcr.io --username "$REGISTRY_USER" --password-stdin
docker --config "$REGISTRY_CONFIG" pull "$IMAGE"
bash "$ROOT/scripts/promote-demo.sh" "$IMAGE" "$ENV_FILE"
