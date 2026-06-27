FROM node:22-bookworm-slim AS builder
WORKDIR /workspace
ENV CI=true

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/session-agent/package.json packages/session-agent/

RUN corepack enable && \
    corepack prepare npm@11.14.1 --activate && \
    npm install -w @sentropic/remote-protocol -w @sentropic/remote-session-agent --include-workspace-root

COPY packages/protocol/ packages/protocol/
COPY packages/session-agent/ packages/session-agent/

RUN npm run build -w @sentropic/remote-protocol \
 && npm run build -w @sentropic/remote-session-agent

# --- Shared runtime base: everything common to slim AND fat ------------------
# Keep this stage's layer order stable: both final stages build on it, so each
# instruction added/moved here invalidates the cache of BOTH variants.
FROM node:22-bookworm-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production

# bookworm-slim strips ca-certificates and the basic shell tools the CLIs
# expect at runtime. Reinstall the minimum so Node's TLS stack finds the
# root CA bundle (chatgpt.com / api.anthropic.com / etc), and so sessions
# get curl/git/openssh available for the usual codex workflows.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        tini \
        tmux \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# tmux config for deported sessions. Keep this aligned with the proven old-PC
# baseline used by Antoine's local remote sessions: tmux owns the wheel, enters
# copy-mode on first wheel-up, preserves OSC title forwarding, and keeps a large
# scrollback history.
RUN printf '%s\n' \
        'set -g allow-passthrough on' \
        'set -g history-limit 50000' \
        'set -g default-terminal "tmux-256color"' \
        'set -ga terminal-overrides ",*256col*:Tc,xterm*:Tc,gnome*:Tc"' \
        'set -g set-clipboard on' \
        'set -g mouse on' \
        'set -g focus-events on' \
        'set -g set-titles on' \
        'set -g set-titles-string "#{pane_title}"' \
        'set -g status-interval 1' \
        'setw -g automatic-rename on' \
        'setw -g automatic-rename-format "#{?pane_title,#{pane_title},#{pane_current_command}}"' \
        'setw -g allow-rename off' \
        "set -g status-right '#[fg=green]remote#[default]'" \
        'bind -n WheelUpPane if -Ft= "#{pane_in_mode}" "send-keys -M" "copy-mode -e; send-keys -M"' \
        'bind -n WheelDownPane send-keys -M' \
        'bind -n PPage copy-mode -eu' \
        'bind -n C-S-c if -F "#{pane_in_mode}" "send-keys -X copy-pipe-and-cancel" "send-keys C-S-c"' \
        'bind -T copy-mode C-S-c send-keys -X copy-pipe-and-cancel' \
        'bind -T copy-mode-vi C-S-c send-keys -X copy-pipe-and-cancel' \
    > /etc/tmux.conf

# Install the agent CLIs available system-wide so any session profile maps to
# a real binary on $PATH. Versions are pinned at image build time.
ARG CODEX_VERSION=0.130.0
ARG CLAUDE_VERSION=2.1.142
RUN npm install -g \
        @openai/codex@${CODEX_VERSION} \
        @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force

# Antigravity CLI (Google) is a self-contained Go binary. Install via the
# official script straight into /usr/local/bin so it is on $PATH for every
# user (the script detects Linux × amd64/arm64 × glibc/musl and resolves the
# right release artifact).
ARG ANTIGRAVITY_INSTALL_URL=https://antigravity.google/cli/install.sh
RUN curl -fsSL "${ANTIGRAVITY_INSTALL_URL}" | bash -s -- --dir /usr/local/bin \
 && agy --help >/dev/null

# Everyday session tools (small): present in slim and fat alike.
RUN apt-get update && apt-get install -y --no-install-recommends \
        jq ripgrep unzip less vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh)
ARG GH_VERSION=2.63.2
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      | tar -xz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh_*

# Scaleway CLI (scw)
ARG SCW_VERSION=2.34.0
RUN curl -fsSL "https://github.com/scaleway/scaleway-cli/releases/download/v${SCW_VERSION}/scaleway-cli_${SCW_VERSION}_linux_amd64" \
      -o /usr/local/bin/scw \
 && chmod +x /usr/local/bin/scw

# --- Slim runtime: CLIs + everyday tools, NO language toolchains -------------
# Built only via `--target runtime-slim` (tagged :*-slim in CI). Cuts the
# cold-pull for session profiles that never compile anything: no Go, no Rust,
# no build-essential/python. NOT the default — the fat stage stays last so a
# bare `docker build` keeps producing the full dev box.
FROM runtime-base AS runtime-slim

# Copy the entire installed workspace (with hoisted node_modules) plus the
# compiled dist outputs. node-pty's native binary built in the builder stage
# is preserved this way without rerunning native compilation.
COPY --from=builder /workspace/package.json /workspace/package-lock.json ./
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages/protocol/package.json packages/protocol/
COPY --from=builder /workspace/packages/protocol/dist packages/protocol/dist
COPY --from=builder /workspace/packages/session-agent/package.json packages/session-agent/
COPY --from=builder /workspace/packages/session-agent/dist packages/session-agent/dist

CMD ["node", "packages/session-agent/dist/index.js"]

# --- Fat dev environment: build tools, language toolchains -------------------
# A deported session is a real dev box: it must build/test the project and
# authenticate to the clouds the user works with (gh/scw come from the base).
# KEEP THIS STAGE LAST: `docker build` without --target must yield the fat
# image (default behavior unchanged for live sessions).
FROM runtime-base AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Go
ARG GO_VERSION=1.23.4
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# Rust (system-wide via rustup) with rustfmt + clippy
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
 && rustup component add rustfmt clippy \
 && chmod -R a+rwX "${CARGO_HOME}" "${RUSTUP_HOME}"

# Put rust/go on the DEFAULT PATH: the session runs the CLI in a login shell
# (`bash -lc`), which resets PATH to the system default and would otherwise drop
# /usr/local/cargo/bin and /usr/local/go/bin. Symlink the binaries into
# /usr/local/bin (already on every shell's PATH); CARGO_HOME/RUSTUP_HOME stay in
# the inherited env. Also export them via profile.d for interactive logins.
RUN ln -sf /usr/local/cargo/bin/* /usr/local/bin/ \
 && ln -sf /usr/local/go/bin/* /usr/local/bin/ \
 && printf 'export CARGO_HOME=/usr/local/cargo\nexport RUSTUP_HOME=/usr/local/rustup\nexport PATH=/usr/local/cargo/bin:/usr/local/go/bin:$PATH\n' \
      > /etc/profile.d/dev-toolchains.sh

# Copy the entire installed workspace (with hoisted node_modules) plus the
# compiled dist outputs. node-pty's native binary built in the builder stage
# is preserved this way without rerunning native compilation.
COPY --from=builder /workspace/package.json /workspace/package-lock.json ./
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages/protocol/package.json packages/protocol/
COPY --from=builder /workspace/packages/protocol/dist packages/protocol/dist
COPY --from=builder /workspace/packages/session-agent/package.json packages/session-agent/
COPY --from=builder /workspace/packages/session-agent/dist packages/session-agent/dist

CMD ["node", "packages/session-agent/dist/index.js"]
