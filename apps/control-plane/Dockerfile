FROM node:22-alpine AS builder
WORKDIR /workspace
ENV CI=true

# Copy workspace metadata first to leverage the layer cache
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/operator-ui/package.json apps/operator-ui/
COPY packages/protocol/package.json packages/protocol/
COPY packages/approval-core/package.json packages/approval-core/
COPY packages/browser-bridge/package.json packages/browser-bridge/
COPY packages/k8s-orchestrator/package.json packages/k8s-orchestrator/
COPY packages/secret-broker/package.json packages/secret-broker/
COPY packages/session-agent/package.json packages/session-agent/
COPY packages/terminal-transport/package.json packages/terminal-transport/

RUN corepack enable && \
    corepack prepare npm@11.14.1 --activate && \
    npm install --workspaces --include-workspace-root --ignore-scripts

COPY packages/ packages/
COPY apps/control-plane/ apps/control-plane/

RUN npm run build -w @sentropic/remote-protocol \
 && npm run build -w @sentropic/remote-k8s-orchestrator \
 && npm run build -w @sentropic/remote-control-plane

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
COPY --from=builder /workspace/package.json /workspace/package-lock.json ./
COPY --from=builder /workspace/apps/control-plane/package.json apps/control-plane/
COPY --from=builder /workspace/apps/control-plane/dist apps/control-plane/dist
COPY --from=builder /workspace/packages/protocol/package.json packages/protocol/
COPY --from=builder /workspace/packages/protocol/dist packages/protocol/dist
COPY --from=builder /workspace/packages/k8s-orchestrator/package.json packages/k8s-orchestrator/
COPY --from=builder /workspace/packages/k8s-orchestrator/dist packages/k8s-orchestrator/dist
RUN corepack enable && \
    corepack prepare npm@11.14.1 --activate && \
    npm install --workspaces --include-workspace-root --omit=dev --ignore-scripts
EXPOSE 8080
CMD ["node", "apps/control-plane/dist/index.js"]
