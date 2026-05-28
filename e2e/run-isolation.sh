#!/usr/bin/env bash
# End-to-end two-user isolation against the Docker backend. Starts an in-process
# control-plane with bearer auth enabled (REMOTE_AUTH=bearer + a shared HS256
# secret), mints two user tokens (alice/bob), and asserts that one user can
# neither see nor stop the other's session. No Kubernetes. Builds nothing —
# run `make e2e-isolation` for the full flow.
set -euo pipefail

PORT="${PORT:-8080}"
IMAGE="${SESSION_AGENT_IMAGE:-ghcr.io/rhanka/sentropic-remote-session-agent:v0.3.1}"
SECRET="${REMOTE_AUTH_SECRET:-e2e-isolation-secret}"
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

# Mint two HS256 JWTs (sub = userId) using the control-plane's `jose` dep.
mint() {
  node --input-type=module -e "
    import { SignJWT } from 'jose';
    const tok = await new SignJWT({ sub: process.argv[1] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(new TextEncoder().encode(process.argv[2]));
    process.stdout.write(tok);
  " "$1" "$SECRET"
}

echo "[e2e-isolation] minting bearer tokens (alice, bob)"
E2E_TOKEN_A="$(mint alice "$SECRET")"
E2E_TOKEN_B="$(mint bob "$SECRET")"
export E2E_TOKEN_A E2E_TOKEN_B

echo "[e2e-isolation] starting control-plane (SESSION_BACKEND=docker, REMOTE_AUTH=bearer, image=$IMAGE)"
SESSION_BACKEND=docker \
  SESSION_AGENT_IMAGE="$IMAGE" \
  REMOTE_AUTH=bearer \
  REMOTE_AUTH_SECRET="$SECRET" \
  PORT="$PORT" HOST=0.0.0.0 \
  node apps/control-plane/dist/index.js >"$ROOT/e2e-isolation-cp.log" 2>&1 &
CP=$!

for i in $(seq 1 30); do
  curl -fsS --max-time 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://localhost:$PORT/healthz" >/dev/null \
  || { echo "[e2e-isolation] control-plane did not come up"; cat "$ROOT/e2e-isolation-cp.log"; exit 1; }

echo "[e2e-isolation] running two-user isolation test"
# REMOTE_AUTH_SECRET is exported so the test can mint a per-session service
# token (aud=remote-session-agent) and assert the agent's callbacks under it
# are accepted (not 401) — the auth path the control-plane injects as
# REMOTE_TOKEN at provision time.
REMOTE_E2E_BASE_URL="http://localhost:$PORT" \
  REMOTE_AUTH_SECRET="$SECRET" \
  npx vitest run e2e/two-user-isolation.test.ts --testTimeout=240000
