import { describe, expect, it } from "vitest";

import {
  findProjectedAgent,
  projectRemoteAgentInspect,
  projectRemoteAgents,
  type RemoteAgentsEnvelope,
} from "./agents-projection.js";
import type { RegistryEntry, LocalLsRow } from "./registry.js";

function job(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "j1",
    tool: "claude",
    kind: "local-tmux",
    cwd: "/repo/.remote/jobs/j1/wt",
    originCwd: "/repo",
    tmuxSession: "remote-job-j1",
    enrolledAt: "2026-06-26T00:00:00.000Z",
    lastSeenAt: "2026-06-26T00:00:01.000Z",
    source: "run",
    role: "job",
    jobState: "running",
    task: "do work",
    ...overrides,
  };
}

function local(overrides: Partial<LocalLsRow> = {}): LocalLsRow {
  return {
    slug: "proj",
    profile: "codex",
    state: "detached",
    path: "/repo2",
    badge: "registry",
    ...overrides,
  };
}

describe("projectRemoteAgents", () => {
  it("projects delegated jobs and local sessions without owning objective state", () => {
    const envelope: RemoteAgentsEnvelope = projectRemoteAgents({
      jobs: [job()],
      localRows: [local({ badge: "guess" })],
    });

    expect(envelope).toMatchObject({
      kind: "remote-agents-list",
      version: 1,
      warnings: [],
      degraded: false,
    });
    expect(envelope.agents).toHaveLength(2);
    expect(envelope.agents.every((agent) => agent.capabilities.objectiveStateAuthority === false)).toBe(true);

    const jobAgent = findProjectedAgent(envelope.agents, "j1")!;
    expect(jobAgent).toMatchObject({
      id: "job:j1",
      kind: "delegated-job",
      state: "running",
      cwd: "/repo",
      jobId: "j1",
      h2aInstance: "remote-job:claude:j1",
      sources: [{ kind: "job-registry", id: "j1" }],
      capabilities: { attach: true, logs: true, remote: false, objectiveStateAuthority: false },
    });

    const localAgent = findProjectedAgent(envelope.agents, "remote-proj")!;
    expect(localAgent).toMatchObject({
      id: "local:proj",
      kind: "local-session",
      tool: "codex",
      conflicts: ["not-enrolled-in-registry"],
      capabilities: { attach: true, logs: true, remote: false, objectiveStateAuthority: false },
    });
  });

  it("marks remote headless jobs as non-attachable but loggable", () => {
    const envelope = projectRemoteAgents({
      jobs: [job({ kind: "remote", remoteId: "sess-1", headless: true })],
      localRows: [],
    });

    expect(envelope.agents[0]).toMatchObject({
      remoteSessionId: "sess-1",
      capabilities: { attach: false, logs: true, remote: true, objectiveStateAuthority: false },
    });
  });

  it("projects inspect detail envelope with empty related sources", () => {
    const envelope = projectRemoteAgents({ jobs: [job()], localRows: [] });
    const agent = findProjectedAgent(envelope.agents, "j1")!;

    expect(projectRemoteAgentInspect(agent)).toMatchObject({
      kind: "remote-agent-detail",
      version: 1,
      agent: { id: "job:j1", authoritativeForObjectiveState: false },
      related: { jobs: [], sessions: [], logs: [] },
      warnings: [],
    });
  });
});
