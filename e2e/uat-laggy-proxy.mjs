#!/usr/bin/env node
// Reproduce a flaky network between `remote codex|claude` and the control-plane.
// Run it locally, then point the CLI at the proxy instead of localhost:8080.
//
// Usage:
//   node e2e/uat-laggy-proxy.mjs \
//       --upstream http://localhost:8080 \
//       --listen 8090 \
//       --rtt 200 --jitter 50 \
//       [--loss 0.02] [--blip-after 20] [--verbose]
//
//   remote codex --remote http://localhost:8090 --target scaleway-kapsule
//
// Output: one JSON event per request on stderr, plus a periodic summary on stdout.

import http from "node:http";
import { URL } from "node:url";
import { performance } from "node:perf_hooks";

const ARGS = parseArgs(process.argv.slice(2));
const UPSTREAM = new URL(ARGS.upstream ?? "http://localhost:8080");
const LISTEN_PORT = Number(ARGS.listen ?? 8090);
const RTT_MS = Number(ARGS.rtt ?? 0);
const JITTER_MS = Number(ARGS.jitter ?? 0);
const LOSS = Number(ARGS.loss ?? 0);
const BLIP_AFTER = ARGS["blip-after"] ? Number(ARGS["blip-after"]) : null;
const VERBOSE = Boolean(ARGS.verbose);

const stats = {
  startedAt: Date.now(),
  total: 0,
  byMethod: new Map(),
  byPath: new Map(),
  dropped: 0,
  failed: 0,
  inputPosts: 0,
  inputAcked: 0,
  rttSamples: [],
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function jitteredDelay() {
  const jitter = JITTER_MS > 0 ? (Math.random() * 2 - 1) * JITTER_MS : 0;
  return Math.max(0, RTT_MS / 2 + jitter);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...event });
  process.stderr.write(line + "\n");
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function pctile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return Math.round(sorted[idx]);
}

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const server = http.createServer(async (clientReq, clientRes) => {
  const id = ++stats.total;
  bump(stats.byMethod, clientReq.method ?? "GET");
  const pathKey = (clientReq.url ?? "/").split("?")[0];
  bump(stats.byPath, pathKey);

  const isInput =
    clientReq.method === "POST" && pathKey.endsWith("/terminal/input");
  if (isInput) stats.inputPosts++;

  // Simulate connection drop
  if (LOSS > 0 && Math.random() < LOSS) {
    stats.dropped++;
    log({
      kind: "drop",
      id,
      method: clientReq.method,
      path: pathKey,
      reason: "loss",
    });
    clientReq.socket.destroy();
    return;
  }
  if (BLIP_AFTER !== null && stats.total % BLIP_AFTER === 0) {
    stats.dropped++;
    log({
      kind: "drop",
      id,
      method: clientReq.method,
      path: pathKey,
      reason: "blip",
    });
    clientReq.socket.destroy();
    return;
  }

  const startedAt = performance.now();
  const delayBefore = jitteredDelay();
  await sleep(delayBefore);

  const upstreamReq = http.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      method: clientReq.method,
      path: clientReq.url,
      headers: { ...clientReq.headers, host: UPSTREAM.host },
      agent: keepAliveAgent,
    },
    async (upstreamRes) => {
      const delayAfter = jitteredDelay();
      await sleep(delayAfter);
      clientRes.writeHead(
        upstreamRes.statusCode ?? 502,
        upstreamRes.statusMessage,
        upstreamRes.headers,
      );
      // Flush headers immediately so SSE clients can start reading
      if (typeof clientRes.flushHeaders === "function")
        clientRes.flushHeaders();
      log({
        kind: "response-head",
        id,
        method: clientReq.method,
        path: pathKey,
        status: upstreamRes.statusCode,
        delayBefore: Math.round(delayBefore),
        delayAfter: Math.round(delayAfter),
      });

      let bytes = 0;
      let chunkCount = 0;
      upstreamRes.on("data", (chunk) => {
        bytes += chunk.length;
        chunkCount++;
        if (VERBOSE && pathKey.includes("/events")) {
          const preview = chunk
            .toString("utf8")
            .slice(0, 80)
            .replace(/\n/g, "\\n");
          log({ kind: "sse-chunk", id, bytes: chunk.length, preview });
        }
        clientRes.write(chunk);
      });
      upstreamRes.on("end", () => {
        const totalMs = Math.round(performance.now() - startedAt);
        stats.rttSamples.push(totalMs);
        if (stats.rttSamples.length > 500) stats.rttSamples.shift();
        if (isInput && (upstreamRes.statusCode ?? 0) < 300) stats.inputAcked++;
        log({
          kind: "response-end",
          id,
          method: clientReq.method,
          path: pathKey,
          status: upstreamRes.statusCode,
          totalMs,
          delayBefore: Math.round(delayBefore),
          delayAfter: Math.round(delayAfter),
          bytes,
          chunks: chunkCount,
        });
        clientRes.end();
      });
      upstreamRes.on("error", (err) => {
        stats.failed++;
        log({ kind: "upstream-error", id, error: String(err) });
        clientRes.destroy();
      });
    },
  );

  upstreamReq.on("error", (err) => {
    stats.failed++;
    log({ kind: "request-error", id, error: String(err) });
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end();
  });

  clientReq.on("aborted", () => upstreamReq.destroy());
  clientReq.pipe(upstreamReq);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  log({
    kind: "listen",
    listen: `http://127.0.0.1:${LISTEN_PORT}`,
    upstream: UPSTREAM.href,
    rtt: RTT_MS,
    jitter: JITTER_MS,
    loss: LOSS,
    blipAfter: BLIP_AFTER,
  });
});

setInterval(() => {
  const uptime = Math.round((Date.now() - stats.startedAt) / 1000);
  const inputLoss =
    stats.inputPosts > 0
      ? Math.round(
          ((stats.inputPosts - stats.inputAcked) / stats.inputPosts) * 100,
        )
      : 0;
  process.stdout.write(
    `[uat-laggy] up=${uptime}s total=${stats.total} dropped=${stats.dropped} ` +
      `failed=${stats.failed} input=${stats.inputAcked}/${stats.inputPosts} (loss=${inputLoss}%) ` +
      `rtt p50=${pctile(stats.rttSamples, 50)}ms p95=${pctile(stats.rttSamples, 95)}ms\n`,
  );
}, 5000).unref();

function shutdown() {
  process.stdout.write("[uat-laggy] shutting down\n");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
