import { describe, expect, it } from "vitest";

import type { SessionDescriptor } from "@sentropic/remote-protocol";

import { DockerSessionProvisioner, type DockerRunner } from "./provisioner.js";

function recorder(): { calls: string[][]; runner: DockerRunner } {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => {
    calls.push([...args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

const descriptor: SessionDescriptor = {
  id: "sess-1",
  profile: "shell",
  target: "docker",
  workspacePath: "/workspace",
  createdAt: "2026-05-27T00:00:00.000Z",
  createdBy: { id: "control-plane", kind: "control-plane" },
};

describe("DockerSessionProvisioner", () => {
  it("runs a session-agent container with the session env and a volume mount", async () => {
    const { calls, runner } = recorder();
    const p = new DockerSessionProvisioner({
      runner,
      image: "img:test",
      controlPlaneEndpoint: "http://host.docker.internal:8080",
    });
    await p.provision(descriptor, () => {});

    const run = calls.find((c) => c[0] === "run");
    expect(run).toBeDefined();
    const flat = run!.join(" ");
    expect(flat).toContain("--name session-sess-1");
    expect(flat).toContain("host.docker.internal:host-gateway");
    expect(flat).toContain("SESSION_ID=sess-1");
    expect(flat).toContain("CONTROL_PLANE_ENDPOINT=http://host.docker.internal:8080");
    expect(flat).toContain("session-sess-1-workspace:/workspace");
    expect(flat.endsWith("img:test")).toBe(true);
  });

  it("mounts a bound workspace volume instead of a per-session one", async () => {
    const { calls, runner } = recorder();
    const p = new DockerSessionProvisioner({ runner, image: "img:test" });
    await p.provision({ ...descriptor, workspaceId: "ws-9" }, () => {});
    const run = calls.find((c) => c[0] === "run")!;
    expect(run.join(" ")).toContain("workspace-ws-9:/workspace");
    expect(run.join(" ")).toContain("SESSION_WORKSPACE_ID=ws-9");
  });

  it("stages credentials as a read-only bind mount", async () => {
    const { calls, runner } = recorder();
    const p = new DockerSessionProvisioner({ runner, image: "img:test" });
    await p.provision(descriptor, () => {}, {
      credentials: { ".codex/auth.json": Buffer.from("tok").toString("base64") },
    });
    const run = calls.find((c) => c[0] === "run")!.join(" ");
    expect(run).toContain("SESSION_AUTH_STAGING_DIR=/run/auth-bundle");
    expect(run).toContain("SESSION_AUTH_BUNDLE_PATHS=.codex/auth.json");
    expect(run).toContain(":/run/auth-bundle:ro");
  });

  it("destroy removes the container + per-session volume, keeps workspace volume", async () => {
    const { calls, runner } = recorder();
    const p = new DockerSessionProvisioner({ runner, image: "img:test" });
    await p.destroy("sess-1", () => {});
    const flat = calls.map((c) => c.join(" "));
    expect(flat).toContain("rm -f session-sess-1");
    expect(flat).toContain("volume rm -f session-sess-1-workspace");
    expect(flat.some((c) => c.includes("workspace-"))).toBe(false);
  });

  it("provisionWorkspace / destroyWorkspace manage the retained volume", async () => {
    const { calls, runner } = recorder();
    const p = new DockerSessionProvisioner({ runner, image: "img:test" });
    await p.provisionWorkspace("ws-9");
    await p.destroyWorkspace("ws-9");
    const flat = calls.map((c) => c.join(" "));
    expect(flat).toContain("volume create workspace-ws-9");
    expect(flat).toContain("volume rm -f workspace-ws-9");
  });
});
