import { describe, expect, it } from "vitest";

import { requestWorkspaceGc } from "./workspace.js";

function fetchStub(args: {
  status: number;
  body: unknown;
  calls: Array<{ url: string; init?: RequestInit }>;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    args.calls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(args.body), {
      status: args.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("requestWorkspaceGc", () => {
  it("POSTs the retention window to /workspaces/gc and returns the report", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const report = {
      candidates: [
        { id: "ws-old1", sizeH: "1.2G", lastModified: "2026-01-01T00:00:00.000Z" },
      ],
      applied: false,
    };
    const result = await requestWorkspaceGc(
      "http://cp.example:8080/",
      { olderThanDays: 14 },
      fetchStub({ status: 200, body: report, calls }),
    );
    expect(result).toEqual(report);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://cp.example:8080/workspaces/gc");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      olderThanDays: 14,
    });
  });

  it("only sends apply when explicitly requested", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await requestWorkspaceGc(
      "http://cp.example:8080",
      { olderThanDays: 30, apply: true },
      fetchStub({
        status: 200,
        body: { candidates: [], applied: true },
        calls,
      }),
    );
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      olderThanDays: 30,
      apply: true,
    });
  });

  it("surfaces the server's error message on failure", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await expect(
      requestWorkspaceGc(
        "http://cp.example:8080",
        {},
        fetchStub({
          status: 502,
          body: {
            code: "workspace.gc_failed",
            message: "janitor pod workspace-gc-x failed",
            retryable: true,
          },
          calls,
        }),
      ),
    ).rejects.toThrow(/502.*janitor pod workspace-gc-x failed/);
  });
});
