#!/usr/bin/env bash
# Run on the demo host after loading the exact image that passed readiness.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-}"
ENV_FILE="${2:-$ROOT/.env.demo}"
if [[ -z "$IMAGE" || "$IMAGE" == *:latest || ( "$IMAGE" != *@sha256:* && "${IMAGE##*/}" != *:* ) ]]; then
  echo "Usage: bash scripts/promote-demo.sh <tested-versioned-image> [demo-env-file]" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Create a private demo env file from deploy/demo/.env.example first." >&2
  exit 2
fi
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
IMAGE_ARCH="$(docker image inspect "$IMAGE_ID" --format '{{.Architecture}}')"
HOST_ARCH="$(docker info --format '{{.Architecture}}')"
case "$HOST_ARCH" in aarch64) HOST_ARCH=arm64 ;; x86_64) HOST_ARCH=amd64 ;; esac
if [[ "$IMAGE_ARCH" != "$HOST_ARCH" ]]; then
  echo "Image architecture $IMAGE_ARCH does not match demo Docker host $HOST_ARCH. Build and test for the target architecture first." >&2
  exit 2
fi
# Pin the resolved ID so a concurrent retag cannot change what is launched.
export BUTTERY_DEMO_IMAGE="$IMAGE_ID" BUTTERY_DEMO_ENV_FILE="$ENV_FILE"
DC=(docker compose --project-name buttery-demo --env-file "$ENV_FILE" --file "$ROOT/deploy/demo/compose.yaml")
umask 077
STATE="$ROOT/.local/demo-releases"
mkdir -p "$STATE/backups"

# Validate without printing any expanded credentials.
"${DC[@]}" config --format json | python3 -c '
import json,re,sys
c=json.load(sys.stdin)
db=c["services"]["db"]["environment"]["POSTGRES_PASSWORD"]
session=c["services"]["app"]["environment"]["SESSION_SECRET"]
assert re.fullmatch(r"[a-fA-F0-9]{64}",db), "DEMO_DB_PASSWORD must be 64 random hex characters"
assert len(session)>=32 and not session.startswith("REPLACE_"), "Set a real DEMO_SESSION_SECRET"
assert db!=session, "Use different database and session secrets"
assert all(p.get("host_ip")=="127.0.0.1" for p in c["services"]["app"].get("ports",[])), "Demo app must bind to loopback behind HTTPS ingress"
print("Demo configuration validated; credentials omitted.")'

PREVIOUS_REF=""
PREVIOUS_ID=""
CONTAINER="$("${DC[@]}" ps --all --quiet app)"
if [[ -n "$CONTAINER" ]]; then
  PREVIOUS_REF="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
  PREVIOUS_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
fi
"${DC[@]}" up --detach --wait --wait-timeout 120 db
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP=""
if [[ -n "$PREVIOUS_ID" ]]; then
  BACKUP="$STATE/backups/$STAMP.dump"
  "${DC[@]}" exec -T db pg_dump --username=buttery --dbname=buttery_demo --format=custom > "$BACKUP"
  echo "Pre-migration database backup saved: $BACKUP"
fi

python3 - "$STATE/$STAMP.json" "$IMAGE" "$IMAGE_ID" "$PREVIOUS_REF" "$PREVIOUS_ID" "$BACKUP" <<'PY'
import json,sys
path,image,image_id,previous,previous_id,backup=sys.argv[1:]
with open(path,"w") as f: json.dump({"status":"started","image":image,"image_id":image_id,"previous_image":previous,"previous_image_id":previous_id,"database_backup":backup},f,indent=2)
PY
if ! "${DC[@]}" up --detach --no-deps --wait --wait-timeout 120 app; then
  echo "Promotion failed. Inspect the demo app logs and the release record: $STATE/$STAMP.json" >&2
  echo "The previous image and database backup are recorded. Check schema compatibility before rolling back; no database restore was attempted." >&2
  exit 1
fi
RUNNING_ID="$(docker inspect "$("${DC[@]}" ps --quiet app)" --format '{{.Image}}')"
if [[ "$RUNNING_ID" != "$IMAGE_ID" ]]; then
  echo "Unexpected running image; promotion is not verified." >&2
  exit 1
fi
python3 - "$STATE/$STAMP.json" "$STATE/latest.json" <<'PY'
import json,sys
record=json.load(open(sys.argv[1])); record["status"]="healthy"
for path in sys.argv[1:]:
    with open(path,"w") as f: json.dump(record,f,indent=2)
PY
echo "Promoted and healthy: $IMAGE ($IMAGE_ID)"
echo "Release record: $STATE/$STAMP.json"
echo "Run the MCP readiness ticket against the demo URL before presenting it."
