#!/usr/bin/env node
// Measure keystroke->echo round-trip through the control-plane, end-to-end.
// Creates a shell session, sends N marker inputs, watches the SSE stream for
// each marker, and reports per-keystroke latency. Point it at the laggy proxy
// to reproduce the freeze the operator sees on bad networks.
//
// Usage:
//   node e2e/uat-keystroke-rtt.mjs \
//       --remote http://localhost:8090 \
//       --target scaleway-kapsule \
//       --count 5 --interval 1000
//
// Output: one JSON event per phase + a summary line at the end.

import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

const ARGS = parseArgs(process.argv.slice(2));
const BASE = (ARGS.remote ?? "http://localhost:8090").replace(/\/$/, "");
const TARGET = ARGS.target ?? "scaleway-kapsule";
const COUNT = Number(ARGS.count ?? 5);
const INTERVAL = Number(ARGS.interval ?? 1000);
const OPEN_TIMEOUT = Number(ARGS["open-timeout"] ?? 90_000);
const POST_AFTER_OPEN_DELAY = Number(ARGS["post-delay"] ?? 500);
const FINAL_DRAIN_MS = Number(ARGS["drain"] ?? 3000);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function log(event) {
  process.stdout.write(
    JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n",
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `POST ${url} -> ${res.status} ${res.statusText} :: ${text.slice(0, 200)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

async function* streamEvents(url, signal) {
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE ${url} -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      let eventName;
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      try {
        yield { event: eventName, envelope: JSON.parse(dataLines.join("\n")) };
      } catch {
        // ignore malformed
      }
    }
  }
}

async function main() {
  const startedAt = performance.now();
  const created = await postJSON(`${BASE}/sessions`, {
    profile: "shell",
    target: TARGET,
    displayName: `uat-keystroke-rtt-${Date.now()}`,
  });
  const sessionId = created.session?.id ?? created.id;
  if (!sessionId)
    throw new Error(`unexpected create response: ${JSON.stringify(created)}`);
  log({
    kind: "session-created",
    sessionId,
    ms: Math.round(performance.now() - startedAt),
  });

  const abort = new AbortController();
  const inflight = new Map(); // nonce -> { sentAt, echoMs?, postMs? }
  let opened = false;
  let exited = false;

  const streamPromise = (async () => {
    try {
      for await (const { envelope } of streamEvents(
        `${BASE}/sessions/${sessionId}/events`,
        abort.signal,
      )) {
        if (envelope.type === "terminal.opened") {
          opened = true;
          log({
            kind: "terminal-opened",
            ms: Math.round(performance.now() - startedAt),
          });
        } else if (envelope.type === "terminal.output") {
          const data = envelope.payload?.data ?? "";
          for (const [nonce, rec] of inflight) {
            if (rec.echoMs !== undefined) continue;
            if (data.includes(nonce)) {
              rec.echoMs = performance.now() - rec.sentAt;
              log({ kind: "echo", nonce, ms: Math.round(rec.echoMs) });
            }
          }
        } else if (envelope.type === "terminal.exited") {
          exited = true;
          log({ kind: "terminal-exited" });
        }
      }
    } catch (err) {
      if (!abort.signal.aborted)
        log({ kind: "stream-error", error: String(err) });
    }
  })();

  const deadline = Date.now() + OPEN_TIMEOUT;
  while (!opened && Date.now() < deadline) await sleep(100);
  if (!opened) {
    abort.abort();
    await postJSON(`${BASE}/sessions/${sessionId}/stop`, {
      reason: "uat-rtt-timeout",
    }).catch(() => {});
    throw new Error(`terminal not opened in ${OPEN_TIMEOUT}ms`);
  }
  await sleep(POST_AFTER_OPEN_DELAY);

  for (let i = 0; i < COUNT && !exited; i++) {
    const nonce = `UAT${crypto.randomBytes(4).toString("hex")}`;
    const payload = `# ${nonce}\n`;
    const rec = { sentAt: performance.now() };
    inflight.set(nonce, rec);
    const t0 = performance.now();
    try {
      await postJSON(`${BASE}/sessions/${sessionId}/terminal/input`, {
        terminalId: "uat-rtt",
        data: payload,
        encoding: "utf8",
      });
      rec.postMs = performance.now() - t0;
      log({ kind: "keystroke-sent", i, nonce, postMs: Math.round(rec.postMs) });
    } catch (err) {
      rec.postError = String(err);
      log({ kind: "keystroke-failed", i, nonce, error: String(err) });
    }
    if (i < COUNT - 1) await sleep(INTERVAL);
  }

  await sleep(FINAL_DRAIN_MS);

  abort.abort();
  await streamPromise;
  await postJSON(`${BASE}/sessions/${sessionId}/stop`, {
    reason: "uat-keystroke-rtt",
  }).catch((err) => log({ kind: "stop-error", error: String(err) }));

  const sent = [...inflight.values()];
  const echoed = sent.filter((r) => r.echoMs !== undefined);
  const lost = sent.filter((r) => r.echoMs === undefined);
  const echoMs = echoed.map((r) => r.echoMs);
  const postMs = sent
    .filter((r) => r.postMs !== undefined)
    .map((r) => r.postMs);

  log({
    kind: "summary",
    sessionId,
    sent: sent.length,
    echoed: echoed.length,
    lost: lost.length,
    post_p50: pctile(postMs, 50),
    post_p95: pctile(postMs, 95),
    echo_p50: pctile(echoMs, 50),
    echo_p95: pctile(echoMs, 95),
    echo_min: echoMs.length ? Math.round(Math.min(...echoMs)) : null,
    echo_max: echoMs.length ? Math.round(Math.max(...echoMs)) : null,
  });
}

main().catch((err) => {
  log({ kind: "fatal", error: String(err) });
  process.exit(1);
});
