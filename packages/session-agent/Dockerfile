FROM node:22-alpine AS builder
WORKDIR /workspace
ENV CI=true
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/session-agent/package.json packages/session-agent/

RUN corepack enable && \
    corepack prepare npm@11.14.1 --activate && \
    npm install -w @sentropic/remote-protocol -w @sentropic/remote-session-agent --include-workspace-root --ignore-scripts

COPY packages/protocol/ packages/protocol/
COPY packages/session-agent/ packages/session-agent/

RUN npm run build -w @sentropic/remote-protocol \
 && npm run build -w @sentropic/remote-session-agent

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /workspace/package.json /workspace/package-lock.json ./
COPY --from=builder /workspace/packages/protocol/package.json packages/protocol/
COPY --from=builder /workspace/packages/protocol/dist packages/protocol/dist
COPY --from=builder /workspace/packages/session-agent/package.json packages/session-agent/
COPY --from=builder /workspace/packages/session-agent/dist packages/session-agent/dist
RUN corepack enable && \
    corepack prepare npm@11.14.1 --activate && \
    npm install -w @sentropic/remote-protocol -w @sentropic/remote-session-agent --include-workspace-root --omit=dev --ignore-scripts
CMD ["node", "packages/session-agent/dist/index.js"]
