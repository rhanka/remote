#!/usr/bin/env bash
# End-to-end session smoke against the Docker backend: an in-process
# control-plane provisions each session as a `docker run` of the session-agent
# image. No Kubernetes. Builds nothing — run `make e2e-docker` for the full flow.
set -euo pipefail

PORT="${PORT:-8080}"
IMAGE="${SESSION_AGENT_IMAGE:-ghcr.io/rhanka/sentropic-remote-session-agent:v0.3.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CP=""
cleanup() {
  [ -n "$CP" ] && kill "$CP" 2>/dev/null || true
  # remove any session-agent containers this run may have left behind
  ids="$(docker ps -aq -f name=session- 2>/dev/null || true)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[e2e-docker] starting control-plane (SESSION_BACKEND=docker, image=$IMAGE)"
SESSION_BACKEND=docker \
  SESSION_AGENT_IMAGE="$IMAGE" \
  PORT="$PORT" HOST=0.0.0.0 \
  node apps/control-plane/dist/index.js >/tmp/e2e-docker-cp.log 2>&1 &
CP=$!

for i in $(seq 1 30); do
  curl -fsS --max-time 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://localhost:$PORT/healthz" >/dev/null \
  || { echo "[e2e-docker] control-plane did not come up"; cat /tmp/e2e-docker-cp.log; exit 1; }

echo "[e2e-docker] running session smoke"
REMOTE_E2E_BASE_URL="http://localhost:$PORT" REMOTE_E2E_TARGET=docker \
  npm run test:e2e:live
