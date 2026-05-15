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

FROM node:22-bookworm-slim AS runtime
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
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the agent CLIs available system-wide so any session profile maps to
# a real binary on $PATH. Versions are pinned at image build time.
ARG CODEX_VERSION=0.130.0
ARG CLAUDE_VERSION=2.1.142
ARG GEMINI_VERSION=0.42.0
RUN npm install -g \
        @openai/codex@${CODEX_VERSION} \
        @anthropic-ai/claude-code@${CLAUDE_VERSION} \
        @google/gemini-cli@${GEMINI_VERSION} \
    && npm cache clean --force

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
