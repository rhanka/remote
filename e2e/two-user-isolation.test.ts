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

  it("accepts the session-agent's callback under a minted per-session token", async () => {
    if (!baseUrl) throw new Error("REMOTE_E2E_BASE_URL required");
    const aTok = process.env.E2E_TOKEN_A!;
    const secret = process.env.REMOTE_AUTH_SECRET!;

    // alice creates a session that exports its workspace.
    const aRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aTok}`,
      },
      body: JSON.stringify({
        profile: "shell",
        target: "docker",
        workspaceExport: true,
      }),
    });
    const a = (await aRes.json()) as { session: { id: string } };

    // Mint the per-session service token the control-plane injects as
    // REMOTE_TOKEN (sub=alice, aud=remote-session-agent), then replay the
    // agent's callbacks with it and assert they are NOT rejected (no 401).
    const { SignJWT } = await import("jose");
    const sessionToken = await new SignJWT({
      sub: "alice",
      sid: a.session.id,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("remote-session-agent")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));

    const cli = await fetch(`${baseUrl}/sessions/${a.session.id}/cli-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ cliSessionId: "conv-e2e" }),
    });
    expect(cli.status).not.toBe(401);
    expect(cli.status).toBe(200);

    const exp = await fetch(
      `${baseUrl}/sessions/${a.session.id}/workspace/export`,
      {
        method: "POST",
        headers: {
          "content-type": "application/gzip",
          authorization: `Bearer ${sessionToken}`,
        },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(exp.status).not.toBe(401);
    expect(exp.status).toBe(200);

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
