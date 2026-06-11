#!/usr/bin/env bash
# WP7 — headful-browser sidecar entrypoint.
#
# Brings up Xvfb → Chromium (headful) → x11vnc → websockify+noVNC, in that
# order, then waits. Reaped by the container runtime on SIGTERM.
#
# Inputs (ALL via env / discrete argv — NEVER interpolated from untrusted data
# into a shell line; the only dynamic secret is NOVNC_TOKEN, read straight from
# the environment by websockify's token plugin, not echoed/logged):
#   NOVNC_PORT   websockify/noVNC port (default 6080)        [env]
#   DISPLAY      X display                (default :99)      [env]
#   GEOMETRY     Xvfb geometry            (default 1280x800x24) [env]
#   NOVNC_TOKEN  per-session access token (REQUIRED for a token-gated route) [env]
#   --display / --geometry / --port / --interactive|--view-only  [argv overrides]
#
# SECURITY: x11vnc binds to localhost only; the sole reachable surface is
# websockify on NOVNC_PORT, which the bridge token-gates. With no token set the
# server starts in a refuse-all mode (logged as a misconfiguration) so a
# token-less forwarded URL never drives the browser.

set -euo pipefail

DISPLAY_NUM="${DISPLAY:-:99}"
GEOMETRY="${GEOMETRY:-1280x800x24}"
PORT="${NOVNC_PORT:-6080}"
INTERACTIVE=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --display) DISPLAY_NUM="$2"; shift 2 ;;
    --geometry) GEOMETRY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --interactive) INTERACTIVE=1; shift ;;
    --view-only) INTERACTIVE=0; shift ;;
    *) echo "[browser] ignoring unknown arg: $1" >&2; shift ;;
  esac
done

export DISPLAY="$DISPLAY_NUM"

cleanup() {
  # Best-effort teardown of the whole stack on SIGTERM/EXIT.
  [ -n "${WS_PID:-}" ] && kill "$WS_PID" 2>/dev/null || true
  [ -n "${VNC_PID:-}" ] && kill "$VNC_PID" 2>/dev/null || true
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup TERM INT EXIT

echo "[browser] starting Xvfb on $DISPLAY ($GEOMETRY)" >&2
Xvfb "$DISPLAY" -screen 0 "$GEOMETRY" -nolisten tcp &
XVFB_PID=$!
# Wait for the display socket.
for _ in $(seq 1 50); do
  if xauth nlist "$DISPLAY" >/dev/null 2>&1 || [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
    break
  fi
  sleep 0.1
done

echo "[browser] starting headful Chromium" >&2
# --no-sandbox: required to run Chromium as root inside a minimal container.
# --start-maximized fills the virtual display. No URL: the user navigates.
chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --window-position=0,0 \
  "about:blank" &
CHROME_PID=$!

echo "[browser] starting x11vnc (localhost only)" >&2
# -localhost: only websockify (same Pod) connects. -nopw: VNC-level auth is off;
# the access gate is the websockify token, not a VNC password (which the user
# can't supply through noVNC's autoconnect URL anyway).
X11VNC_VIEWONLY=""
[ "$INTERACTIVE" -eq 0 ] && X11VNC_VIEWONLY="-viewonly"
x11vnc -display "$DISPLAY" -localhost -nopw -forever -shared $X11VNC_VIEWONLY -rfbport 5900 &
VNC_PID=$!

# Token gate: websockify --token-plugin TokenFile reads a token→target map.
# We write a single mapping <token>: localhost:5900 to a file. Only a client
# connecting with ?token=<token> is routed to the VNC server; any other token
# (or none) gets no target → connection refused.
TOKENS_DIR="$(mktemp -d)"
if [ -n "${NOVNC_TOKEN:-}" ]; then
  # NOVNC_TOKEN comes from our own minted hex (bridge mintNoVncToken); written
  # to a file, never echoed to logs.
  printf '%s: localhost:5900\n' "$NOVNC_TOKEN" > "$TOKENS_DIR/tokens"
  echo "[browser] websockify token gate ENABLED" >&2
else
  # No token → refuse-all: empty token map means no client is ever routed.
  : > "$TOKENS_DIR/tokens"
  echo "[browser] WARNING: NOVNC_TOKEN unset — refusing all connections" >&2
fi

echo "[browser] starting websockify + noVNC on :$PORT" >&2
websockify --web=/usr/share/novnc --token-plugin=TokenFile --token-source="$TOKENS_DIR/tokens" "$PORT" &
WS_PID=$!

# Wait on websockify (the user-facing process); if it dies, tear everything down.
wait "$WS_PID"
