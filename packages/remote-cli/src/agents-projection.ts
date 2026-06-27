import type { RegistryEntry, LocalLsRow } from "./registry.js";

export type RemoteAgentSourceKind = "job-registry" | "local-tmux";
export type RemoteAgentState =
  | "pending"
  | "running"
  | "throttled"
  | "done"
  | "failed"
  | "attached"
  | "detached"
  | "live";

export type RemoteAgentProjection = {
  id: string;
  ownerSystem: "remote";
  authoritativeForObjectiveState: false;
  kind: "delegated-job" | "local-session";
  tool: string;
  state: RemoteAgentState;
  cwd: string;
  label?: string;
  tmuxSession?: string;
  remoteSessionId?: string;
  jobId?: string;
  h2aInstance?: string;
  sources: Array<{ kind: RemoteAgentSourceKind; id: string }>;
  conflicts: string[];
  capabilities: {
    attach: boolean;
    logs: boolean;
    remote: boolean;
    objectiveStateAuthority: false;
  };
};

export type RemoteAgentsEnvelope = {
  kind: "remote-agents-list";
  version: 1;
  agents: RemoteAgentProjection[];
  warnings: string[];
  degraded: false;
};

export type RemoteAgentInspectEnvelope = {
  kind: "remote-agent-detail";
  version: 1;
  agent: RemoteAgentProjection;
  related: {
    jobs: unknown[];
    sessions: unknown[];
    logs: unknown[];
  };
  warnings: string[];
};

export function agentInstanceForJob(job: RegistryEntry): string {
  return `remote-job:${job.tool}:${job.id}`;
}

export function projectJobAgent(job: RegistryEntry): RemoteAgentProjection {
  const remote = job.kind === "remote";
  const state = (job.jobState ?? "pending") as RemoteAgentState;
  return {
    id: `job:${job.id}`,
    ownerSystem: "remote",
    authoritativeForObjectiveState: false,
    kind: "delegated-job",
    tool: job.tool,
    state,
    cwd: job.originCwd ?? job.cwd,
    ...(job.label !== undefined ? { label: job.label } : {}),
    ...(job.tmuxSession !== undefined ? { tmuxSession: job.tmuxSession } : {}),
    ...(job.remoteId !== undefined ? { remoteSessionId: job.remoteId } : {}),
    jobId: job.id,
    h2aInstance: agentInstanceForJob(job),
    sources: [{ kind: "job-registry", id: job.id }],
    conflicts: [],
    capabilities: {
      attach: !job.headless,
      logs: true,
      remote,
      objectiveStateAuthority: false,
    },
  };
}

export function projectLocalSessionAgent(row: LocalLsRow): RemoteAgentProjection {
  const id = `local:${row.slug}`;
  return {
    id,
    ownerSystem: "remote",
    authoritativeForObjectiveState: false,
    kind: "local-session",
    tool: row.profile,
    state: row.state,
    cwd: row.path,
    ...(row.displayName !== undefined ? { label: row.displayName } : {}),
    tmuxSession: `remote-${row.slug}`,
    sources: [{ kind: "local-tmux", id: row.slug }],
    conflicts: row.badge === "guess" ? ["not-enrolled-in-registry"] : [],
    capabilities: {
      attach: true,
      logs: true,
      remote: false,
      objectiveStateAuthority: false,
    },
  };
}

export function projectRemoteAgents(args: {
  jobs: readonly RegistryEntry[];
  localRows: readonly LocalLsRow[];
}): RemoteAgentsEnvelope {
  const agents = [
    ...args.jobs.map(projectJobAgent),
    ...args.localRows.map(projectLocalSessionAgent),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return {
    kind: "remote-agents-list",
    version: 1,
    agents,
    warnings: [],
    degraded: false,
  };
}

export function projectRemoteAgentInspect(
  agent: RemoteAgentProjection,
): RemoteAgentInspectEnvelope {
  return {
    kind: "remote-agent-detail",
    version: 1,
    agent,
    related: { jobs: [], sessions: [], logs: [] },
    warnings: [],
  };
}

export function findProjectedAgent(
  agents: readonly RemoteAgentProjection[],
  selector: string,
): RemoteAgentProjection | undefined {
  return agents.find(
    (agent) =>
      agent.id === selector ||
      agent.jobId === selector ||
      agent.tmuxSession === selector ||
      agent.remoteSessionId === selector ||
      agent.h2aInstance === selector ||
      agent.label === selector,
  );
}
