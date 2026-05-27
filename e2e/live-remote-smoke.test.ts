import { afterEach, describe, expect, it } from "vitest";

import {
  createSession,
  listSessions,
  stopSession,
} from "../apps/operator-ui/src/lib/api.js";
import { attach } from "../packages/remote-cli/src/attach.js";

const baseUrl = process.env.REMOTE_E2E_BASE_URL;
const target = process.env.REMOTE_E2E_TARGET ?? "scaleway-kapsule";

const runIfConfigured = baseUrl ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stdinStub(): NodeJS.ReadStream {
  return {
    isTTY: false,
    resume() {},
    pause() {},
    on() {
      return this as unknown as NodeJS.ReadStream;
    },
    off() {
      return this as unknown as NodeJS.ReadStream;
    },
  } as unknown as NodeJS.ReadStream;
}

function writableStub(): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    columns: 100,
    rows: 30,
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    on() {
      return this as unknown as NodeJS.WriteStream;
    },
    chunks,
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

async function postTerminalInputWithRetry(
  sessionId: string,
  data: string,
): Promise<void> {
  if (!baseUrl) throw new Error("REMOTE_E2E_BASE_URL is required");
  const deadline = Date.now() + 120_000;
  let lastStatus = "not attempted";

  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/sessions/${sessionId}/terminal/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          terminalId: "e2e-live-smoke",
          data,
          encoding: "utf8",
        }),
      },
    );
    if (response.status === 202) return;
    lastStatus = `${response.status} ${response.statusText}`;
    await sleep(1_000);
  }

  throw new Error(`terminal input was not accepted: ${lastStatus}`);
}

runIfConfigured("live remote smoke", () => {
  let sessionId: string | undefined;

  afterEach(async () => {
    if (!baseUrl || !sessionId) return;
    await stopSession(baseUrl, sessionId, "e2e-live-cleanup").catch(() => {});
    sessionId = undefined;
  });

  it("creates a shell session and streams terminal output through remote attach", async () => {
    if (!baseUrl) throw new Error("REMOTE_E2E_BASE_URL is required");

    const marker = `E2E_LIVE_SMOKE_OK_${Date.now()}`;
    const session = await createSession(baseUrl, {
      profile: "shell",
      target,
      displayName: `e2e-live-${Date.now()}`,
    });
    sessionId = session.id;

    const stdout = writableStub();
    const stderr = writableStub();
    const attached = await attach({
      baseUrl,
      sessionId,
      stdin: stdinStub(),
      stdout,
      stderr,
    });

    await postTerminalInputWithRetry(
      session.id,
      `echo ${marker} && pwd\nexit\n`,
    );
    await attached.finished;

    const output = stdout.chunks.join("");
    expect(output).toContain(marker);
    expect(output).toContain("/workspace");

    // The `exit` above ends the shell, so the control-plane's cleanup cascade
    // auto-stops the session. A redundant stop may 404; either way the session
    // must leave the list shortly.
    await stopSession(baseUrl, session.id, "e2e-live-complete").catch(() => {});
    sessionId = undefined;
    let gone = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const sessions = await listSessions(baseUrl);
      if (!sessions.some((candidate) => candidate.id === session.id)) {
        gone = true;
        break;
      }
      await sleep(1_000);
    }
    expect(gone).toBe(true);
  });
});
