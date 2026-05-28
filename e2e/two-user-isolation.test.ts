import { describe, expect, it } from "vitest";

const baseUrl = process.env.REMOTE_E2E_BASE_URL;
const runIf = baseUrl ? describe : describe.skip;

async function listFor(token: string) {
  const res = await fetch(`${baseUrl}/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as { sessions: Array<{ id: string }> };
}

runIf("two-user isolation", () => {
  it("user B cannot see or stop user A's session", async () => {
    if (!baseUrl) throw new Error("REMOTE_E2E_BASE_URL required");
    const aTok = process.env.E2E_TOKEN_A!;
    const bTok = process.env.E2E_TOKEN_B!;
    const aRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aTok}`,
      },
      body: JSON.stringify({ profile: "shell", target: "docker" }),
    });
    const a = (await aRes.json()) as { session: { id: string } };
    const bList = await listFor(bTok);
    expect(bList.sessions.some((s) => s.id === a.session.id)).toBe(false);
    const bStop = await fetch(`${baseUrl}/sessions/${a.session.id}/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bTok}`,
      },
      body: "{}",
    });
    expect(bStop.status).toBe(404);
    await fetch(`${baseUrl}/sessions/${a.session.id}/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aTok}`,
      },
      body: "{}",
    });
  });
});
