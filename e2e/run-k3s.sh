#!/usr/bin/env bash
# End-to-end session smoke against the k3s (k3d) backend. Assumes the cluster is
# already up with the control-plane deployed (run via `make e2e-k3s`, which does
# `make demo` first). Port-forwards and runs the session smoke.
set -euo pipefail

PORT="${PORT:-8080}"
NS="${NAMESPACE:-sentropic-remote}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PF=""
cleanup() { [ -n "$PF" ] && kill "$PF" 2>/dev/null || true; }
trap cleanup EXIT

echo "[e2e-k3s] port-forwarding control-plane"
kubectl -n "$NS" port-forward svc/sentropic-remote-control-plane "$PORT:8080" \
  >/tmp/e2e-k3s-pf.log 2>&1 &
PF=$!

for i in $(seq 1 30); do
  curl -fsS --max-time 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://localhost:$PORT/healthz" >/dev/null \
  || { echo "[e2e-k3s] control-plane not reachable"; cat /tmp/e2e-k3s-pf.log; exit 1; }

echo "[e2e-k3s] running session smoke"
REMOTE_E2E_BASE_URL="http://localhost:$PORT" REMOTE_E2E_TARGET=k3s \
  npm run test:e2e:live
