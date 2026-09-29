#!/usr/bin/env bash
# DuploCloud's official DevKit, isolated from Buttery's application containers.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVKIT="$ROOT/.local/duplocloud-devkit"
if [[ ! -f "$DEVKIT/run.sh" ]]; then
  echo "Local DevKit missing. See docs/duplocloud-local.md." >&2
  exit 1
fi
cd "$DEVKIT"
umask 077
# Keep the local project and its localhost-only override consistent across shells.
export COMPOSE_PROJECT_NAME=buttery-duplo
export COMPOSE_FILE="$DEVKIT/docker-compose.yml:$DEVKIT/compose.override.yaml"
# An inherited API or cloud credential must not override the selected subscription.
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
unset AZURE_BASE_URL AZURE_API_KEY AZURE_CLIENT_ID
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN
case "${1:-start}" in
  start) exec ./run.sh --model subscription ;;
  stop) exec ./stop.sh ;;
  status) exec docker compose ps ;;
  *) echo "Usage: bash scripts/duplo-local.sh [start|stop|status]" >&2; exit 2 ;;
esac
