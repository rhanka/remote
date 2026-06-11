# WP7 — headful-browser sidecar (noVNC) for the session Pod.
#
# Brings up a real Chromium DESKTOP a human can drive through their own browser
# (noVNC) to complete a 2FA / login challenge on an authenticated site:
#
#   Xvfb (virtual X display :99)
#     └─ Chromium (headful, on :99)
#   x11vnc (VNC server bound to :99, password-less — see SECURITY)
#     └─ websockify + noVNC static assets on :6080  ← `remote forward` target
#
# This is a DEDICATED image, NOT baked into the session-agent: the X/font/
# Chromium stack is large and unused by ~all sessions, so it is scheduled as an
# opt-in SIDECAR only when a browser session is requested (see the k8s spec
# `buildBrowserSidecarContainer`). Pin the base; never :latest.
#
# SECURITY: the VNC server itself is bound to localhost inside the Pod; the only
# externally reachable surface is websockify on :6080, which `remote forward`
# binds to 127.0.0.1 on the user's machine. websockify is started with a
# per-session token gate (NOVNC_TOKEN injected at RUNTIME by the bridge — never
# baked into the image or the Pod manifest), so a forwarded URL without the
# token is rejected. Default geometry/display are reversible (env-overridable).

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Xvfb + a VNC server + websockify + Chromium + fonts. chromium is in Debian
# main on bookworm. fonts-liberation/noto give legible UI + emoji.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        novnc \
        python3 \
        websockify \
        x11vnc \
        xauth \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# noVNC ships its assets under /usr/share/novnc on Debian; expose vnc.html at /.
RUN mkdir -p /opt/browser \
    && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# Root build context (matches the CI matrix `context: .`).
COPY packages/browser-bridge/docker/start-headful.sh /opt/browser/start-headful.sh
RUN chmod +x /opt/browser/start-headful.sh

EXPOSE 6080

# tini reaps the X/Chromium/websockify children cleanly on SIGTERM.
ENTRYPOINT ["/opt/browser/start-headful.sh"]
