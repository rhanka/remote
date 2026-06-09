import { describe, expect, it, vi } from "vitest";

import {
  buildPortForwardArgs,
  ensureSessionExists,
  localForwardUrl,
  portMapping,
  sessionPodName,
} from "./forward.js";

type SessionRow = Awaited<ReturnType<typeof import("./attach.js").listRemoteSessions>>[number];

function session(id: string): SessionRow {
  return {
    id,
    profile: "claude",
    target: "scaleway-kapsule",
    createdAt: "2026-06-08T00:00:00.000Z",
  };
}

describe("sessionPodName", () => {
  it("prefixes the session id with session-", () => {
    expect(sessionPodName("abc123")).toBe("session-abc123");
  });
});

describe("portMapping", () => {
  it("maps localPort:podPort when a local port is given", () => {
    expect(portMapping(8025, 9000)).toBe("9000:8025");
  });

  it("falls back to just the pod port when no local port is given (kubectl picks one)", () => {
    expect(portMapping(8025)).toBe("8025");
  });
});

describe("localForwardUrl", () => {
  it("uses the local port when present", () => {
    expect(localForwardUrl(8025, 9000)).toBe("http://localhost:9000");
  });

  it("defaults the local port to the pod port", () => {
    expect(localForwardUrl(8025)).toBe("http://localhost:8025");
  });
});

describe("buildPortForwardArgs", () => {
  it("builds a pod port-forward argv with the default address and pod-port mapping", () => {
    expect(
      buildPortForwardArgs({ namespace: "sessions", sessionId: "abc", podPort: 8025 }),
    ).toEqual([
      "-n",
      "sessions",
      "port-forward",
      "--address=127.0.0.1",
      "pod/session-abc",
      "8025",
    ]);
  });

  it("includes the explicit local port mapping", () => {
    expect(
      buildPortForwardArgs({
        namespace: "ns",
        sessionId: "s1",
        podPort: 8025,
        localPort: 9000,
      }),
    ).toEqual([
      "-n",
      "ns",
      "port-forward",
      "--address=127.0.0.1",
      "pod/session-s1",
      "9000:8025",
    ]);
  });

  it("honours a custom --address", () => {
    expect(
      buildPortForwardArgs({
        namespace: "ns",
        sessionId: "s1",
        podPort: 8025,
        address: "0.0.0.0",
      }),
    ).toEqual([
      "-n",
      "ns",
      "port-forward",
      "--address=0.0.0.0",
      "pod/session-s1",
      "8025",
    ]);
  });
});

describe("ensureSessionExists", () => {
  it("returns undefined when the session is live", async () => {
    const listSessions = vi.fn().mockResolvedValue([session("alive"), session("other")]);
    const result = await ensureSessionExists({
      sessionId: "alive",
      remoteUrl: "https://cp.example",
      listSessions,
    });
    expect(result).toBeUndefined();
    expect(listSessions).toHaveBeenCalledWith("https://cp.example");
  });

  it("returns a clear message listing live ids when the session is unknown", async () => {
    const listSessions = vi.fn().mockResolvedValue([session("a"), session("b")]);
    const result = await ensureSessionExists({
      sessionId: "ghost",
      remoteUrl: "https://cp.example",
      listSessions,
    });
    expect(result).toContain('no remote session "ghost"');
    expect(result).toContain("a, b");
  });

  it("says 'no live sessions' when none exist", async () => {
    const listSessions = vi.fn().mockResolvedValue([]);
    const result = await ensureSessionExists({
      sessionId: "ghost",
      remoteUrl: "https://cp.example",
      listSessions,
    });
    expect(result).toContain('no remote session "ghost"');
    expect(result).toContain("no live sessions");
  });
});
