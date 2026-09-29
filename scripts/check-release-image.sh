#!/usr/bin/env bash
set -euo pipefail
IMAGE="${1:?Usage: check-release-image.sh <image>}"
docker run --rm --network none --entrypoint node "$IMAGE" -e '
const fs = require("node:fs");
for (const path of ["/app/.local", "/app/.env", "/app/.env.demo", "/app/.mcp.json", "/app/.claude", "/app/.codex", "/app/.git"]) {
  if (fs.existsSync(path)) throw new Error(`Private development file included in release: ${path}`);
}
if (!fs.existsSync("/app/apps/web/dist/index.html")) throw new Error("Built web UI missing");
console.log("Release image excludes private development files and includes the built UI.");'
