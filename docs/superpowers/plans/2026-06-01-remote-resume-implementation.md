# Remote Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `remote env` and `remote resume` so `remote` becomes the source of truth for development-session layouts, inventory, and tab relaunch across local and remote sessions.

**Architecture:** Add a focused `packages/remote-cli/src/resume/` module that owns environment config, candidate discovery, layout planning, and terminal launch artifacts. Extend the existing session descriptor and migrate flow just enough to carry pairing timestamps and metadata, then wire Commander commands in `packages/remote-cli/src/index.ts` to the new module.

**Tech Stack:** TypeScript, Commander, Vitest, Node `fs/path/os/child_process`, existing `@sentropic/remote-protocol` schema types, Hono control-plane routes.

---

## File Structure

- Create: `packages/remote-cli/src/resume/types.ts`
  Shared environment, candidate, launch-plan, and JSON report types.
- Create: `packages/remote-cli/src/resume/environment.ts`
  Environment-name validation, config paths, built-in `dev` template, init/read/list/edit/validate helpers.
- Create: `packages/remote-cli/src/resume/environment.test.ts`
  Environment storage, bootstrap, traversal rejection, and validation tests.
- Create: `packages/remote-cli/src/resume/discovery.ts`
  Local transcript scanning, local-process detection, remote summary pairing, launch-mode resolution.
- Create: `packages/remote-cli/src/resume/discovery.test.ts`
  Fixture-based discovery, canonicalization, pairing, and `status-only` tests.
- Create: `packages/remote-cli/src/resume/layout.ts`
  Group/shared-window planning, overflow ordering, and title-label preparation.
- Create: `packages/remote-cli/src/resume/layout.test.ts`
  Deterministic layout and overflow tests.
- Create: `packages/remote-cli/src/resume/launcher.ts`
  GNOME Terminal artifact generation, wrapper scripts, launch-map I/O, title rendering, and `run-tab`.
- Create: `packages/remote-cli/src/resume/launcher.test.ts`
  Slot-id binding, wrapper-command generation, and `run-tab` safety tests.
- Create: `docs/remote-resume.md`
  User-facing command reference and behavior notes.
- Modify: `packages/remote-cli/src/config.ts:5-85`
  Add shared config-root/environment-dir helpers while leaving token/default-remote storage untouched.
- Modify: `packages/remote-cli/src/config.test.ts:1-34`
  Reuse the isolated config-home pattern for environment-path tests.
- Modify: `packages/remote-cli/src/attach.ts:297-436`
  Return richer remote session summaries and keep `createRemoteSession()` metadata merging intact.
- Modify: `packages/remote-cli/src/attach.test.ts:1-260, 507-537`
  Verify list parsing and metadata forwarding.
- Modify: `packages/remote-cli/src/migrate.ts:52-121, 346-541`
  Accept explicit display/metadata overrides, emit pairing metadata, and stop the correct workspace-bound session on migrate-back.
- Modify: `packages/remote-cli/src/migrate.test.ts:1-587`
  Cover metadata emission and workspace-specific stop selection.
- Modify: `packages/remote-cli/src/index.ts:7-20, 63-104, 900-1060`
  Export resume helpers and register `remote env`, `remote resume`, and internal `remote resume run-tab`.
- Modify: `packages/remote-cli/src/index.test.ts:1-453`
  Cover Commander wiring and JSON/report-only behavior.
- Modify: `packages/protocol/src/schemas/session.ts:13-153`
  Add optional `startedAt` and `updatedAt` fields to `SessionDescriptor`.
- Modify: `apps/control-plane/src/sessions/store.ts:1-35`
  Stamp `updatedAt` on descriptor writes while preserving `createdAt` and `startedAt`.
- Modify: `apps/control-plane/src/routes/sessions.ts:58-81, 349-359`
  Populate timestamps on create and preserve them on later descriptor updates.
- Modify: `apps/control-plane/src/index.test.ts:232-274, 720-844`
  Validate descriptor timestamps, metadata, and callback persistence.

### Task 1: Resume Environment Foundation

**Files:**
- Create: `packages/remote-cli/src/resume/types.ts`
- Create: `packages/remote-cli/src/resume/environment.ts`
- Create: `packages/remote-cli/src/resume/environment.test.ts`
- Modify: `packages/remote-cli/src/config.ts:5-85`
- Modify: `packages/remote-cli/src/config.test.ts:1-34`

- [ ] **Step 1: Write the failing environment tests**

```ts
// packages/remote-cli/src/resume/environment.test.ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertEnvironmentName,
  editEnvironment,
  initEnvironment,
  listEnvironments,
  readEnvironment,
  resolveEnvironmentPath,
  validateEnvironment,
} from "./environment.js";

const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  ".env-test",
);

let prevHome: string | undefined;
let scratch: string | undefined;

beforeEach(() => {
  prevHome = process.env.REMOTE_CLI_CONFIG_HOME;
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "h-"));
  process.env.REMOTE_CLI_CONFIG_HOME = scratch;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.REMOTE_CLI_CONFIG_HOME;
  else process.env.REMOTE_CLI_CONFIG_HOME = prevHome;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("resume environments", () => {
  it("materializes the built-in dev environment under the managed remote path", () => {
    const env = initEnvironment("dev");
    expect(resolveEnvironmentPath("dev")).toMatch(
      /sentropic\/remote\/environments\/dev\.json$/,
    );
    expect(env.name).toBe("dev");
    expect(env.terminal.maxWindows).toBe(4);
    expect(readEnvironment("dev").projects.sentropic.maxSessions).toBe(12);
  });

  it("lists initialized environments alphabetically", () => {
    initEnvironment("prod");
    initEnvironment("dev");
    expect(listEnvironments()).toEqual(["dev", "prod"]);
  });

  it("rejects traversal and absolute names before touching the filesystem", () => {
    expect(() => assertEnvironmentName("../prod")).toThrow(/environment name/i);
    expect(() => resolveEnvironmentPath("/tmp/pwn")).toThrow(/environment name/i);
  });

  it("reports semantic validation errors for impossible window allocations", () => {
    initEnvironment("dev");
    const env = readEnvironment("dev");
    env.layout.sharedWindows = 4;
    expect(validateEnvironment(env)).toContain(
      "layout.groups + sharedWindows must be <= terminal.maxWindows",
    );
  });

  it("returns the managed file path for editor launches", () => {
    initEnvironment("dev");
    expect(editEnvironment("dev")).toBe(resolveEnvironmentPath("dev"));
  });
});
```

```ts
// packages/remote-cli/src/config.test.ts
import { resolveConfigPath, resolveEnvironmentPath } from "./config.js";

it("keeps CLI auth config and resume environments in separate managed paths", () => {
  expect(resolveConfigPath()).toMatch(/sentropic\/remote-cli\/config\.json$/);
  expect(resolveEnvironmentPath("dev")).toMatch(
    /sentropic\/remote\/environments\/dev\.json$/,
  );
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w @sentropic/remote-cli -- src/config.test.ts src/resume/environment.test.ts`

Expected: FAIL with module-not-found / missing export errors for `./resume/environment.js` and `resolveEnvironmentPath()`.

- [ ] **Step 3: Implement the environment types and storage helpers**

```ts
// packages/remote-cli/src/resume/types.ts
export type ResumeProjectConfig = {
  maxSessions: number;
  roots?: string[];
};

export type ResumeEnvironment = {
  version: 1;
  name: string;
  terminal: {
    app: "gnome-terminal";
    maxWindows: number;
    maxTabsPerWindow: number;
    titleTemplate: string;
  };
  inventory: {
    localLookbackHours: number;
    profiles: string[];
    remoteUrl: string;
  };
  layout: {
    groups: Array<{
      name: string;
      projects: string[];
      slots?: number;
    }>;
    sharedWindows: number;
  };
  projects: Record<string, ResumeProjectConfig>;
};
```

```ts
// packages/remote-cli/src/config.ts
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ENVIRONMENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function configHome(): string {
  return process.env.REMOTE_CLI_CONFIG_HOME ?? homedir();
}

export function resolveSentropicConfigRoot(): string {
  return join(configHome(), ".config", "sentropic");
}

export function resolveConfigPath(): string {
  return join(resolveSentropicConfigRoot(), "remote-cli", "config.json");
}

export function assertEnvironmentName(name: string): string {
  const trimmed = name.trim();
  if (!ENVIRONMENT_NAME_RE.test(trimmed)) {
    throw new Error(
      'Invalid environment name. Use ^[a-z0-9][a-z0-9._-]{0,63}$.',
    );
  }
  return trimmed;
}

export function resolveEnvironmentsDir(): string {
  return join(resolveSentropicConfigRoot(), "remote", "environments");
}

export function resolveEnvironmentPath(name: string): string {
  const safeName = assertEnvironmentName(name);
  const dir = resolveEnvironmentsDir();
  const path = resolve(dir, `${safeName}.json`);
  const root = resolve(dir) + "/";
  if (!path.startsWith(root)) {
    throw new Error("Invalid environment name.");
  }
  return path;
}
```

```ts
// packages/remote-cli/src/resume/environment.ts
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import {
  assertEnvironmentName,
  resolveEnvironmentPath,
  resolveEnvironmentsDir,
} from "../config.js";
import type { ResumeEnvironment } from "./types.js";

export function defaultDevEnvironment(): ResumeEnvironment {
  return {
    version: 1,
    name: "dev",
    terminal: {
      app: "gnome-terminal",
      maxWindows: 4,
      maxTabsPerWindow: 12,
      titleTemplate: "{project} [{profile} {place} {state}]",
    },
    inventory: {
      localLookbackHours: 48,
      profiles: ["claude", "codex"],
      remoteUrl: "default",
    },
    layout: {
      groups: [
        { name: "sentropic", projects: ["sentropic"], slots: 12 },
        {
          name: "design + h2a",
          projects: ["sent-tech-design-system", "a2a-cli", "remote", "poc-k8s"],
        },
      ],
      sharedWindows: 2,
    },
    projects: {
      sentropic: {
        maxSessions: 12,
        roots: ["/home/antoinefa/src/sentropic"],
      },
      "sent-tech-design-system": { maxSessions: 4 },
      "a2a-cli": { maxSessions: 4 },
      "radar-immobilier": {
        maxSessions: 1,
        roots: ["/home/antoinefa/src/radar-immobilier"],
      },
      "mcp-wave": {
        maxSessions: 1,
        roots: ["/home/antoinefa/src/mcp-wave"],
      },
    },
  };
}

export function validateEnvironment(env: ResumeEnvironment): string[] {
  const errors: string[] = [];
  if (env.version !== 1) errors.push("version must be 1");
  if (env.layout.groups.length + env.layout.sharedWindows > env.terminal.maxWindows) {
    errors.push("layout.groups + sharedWindows must be <= terminal.maxWindows");
  }
  if (env.terminal.maxWindows < 1) errors.push("terminal.maxWindows must be >= 1");
  if (env.terminal.maxTabsPerWindow < 1) {
    errors.push("terminal.maxTabsPerWindow must be >= 1");
  }
  for (const [project, cfg] of Object.entries(env.projects)) {
    if (cfg.maxSessions < 1) errors.push(`projects.${project}.maxSessions must be >= 1`);
  }
  return errors;
}

export function initEnvironment(name = "dev"): ResumeEnvironment {
  const safeName = assertEnvironmentName(name);
  const path = resolveEnvironmentPath(safeName);
  const env = safeName === "dev" ? defaultDevEnvironment() : { ...defaultDevEnvironment(), name: safeName };
  mkdirSync(resolveEnvironmentsDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(env, null, 2) + "\n", "utf8");
  return env;
}

export function readEnvironment(name: string): ResumeEnvironment {
  const raw = readFileSync(resolveEnvironmentPath(name), "utf8");
  return JSON.parse(raw) as ResumeEnvironment;
}

export function listEnvironments(): string[] {
  try {
    return readdirSync(resolveEnvironmentsDir())
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function editEnvironment(name: string): string {
  return resolveEnvironmentPath(name);
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w @sentropic/remote-cli -- src/config.test.ts src/resume/environment.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/remote-cli/src/config.ts \
  packages/remote-cli/src/config.test.ts \
  packages/remote-cli/src/resume/types.ts \
  packages/remote-cli/src/resume/environment.ts \
  packages/remote-cli/src/resume/environment.test.ts
git commit -m "feat(cli): add remote resume environment storage"
```

### Task 2: Session Descriptor Timestamps in Protocol and Control Plane

**Files:**
- Modify: `packages/protocol/src/schemas/session.ts:13-153`
- Modify: `apps/control-plane/src/sessions/store.ts:1-35`
- Modify: `apps/control-plane/src/routes/sessions.ts:58-81, 349-359`
- Modify: `apps/control-plane/src/index.test.ts:232-274, 720-844`

- [ ] **Step 1: Write the failing protocol/control-plane tests**

```ts
// apps/control-plane/src/index.test.ts
it("persists workspace metadata and stamps startedAt/updatedAt on listed sessions", async () => {
  const app = createControlPlane();
  const created = await app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profile: "claude",
      target: "k3s",
      workspaceId: "ws-123",
      displayName: "radar-immobilier",
      metadata: {
        resume: {
          project: "radar-immobilier",
          cwd: "/home/antoinefa/src/radar-immobilier",
        },
      },
    }),
  });

  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as CreateSessionResponse;
  expect(createdBody.session.startedAt).toBeDefined();
  expect(createdBody.session.updatedAt).toBe(createdBody.session.createdAt);

  const cb = await app.request(`/sessions/${createdBody.session.id}/cli-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliSessionId: "conv-123" }),
  });
  expect(cb.status).toBe(200);

  const listed = await app.request("/sessions");
  const listBody = (await listed.json()) as ListSessionsResponse;
  const session = listBody.sessions.find((s) => s.id === createdBody.session.id)!;
  expect(session.workspaceId).toBe("ws-123");
  expect(session.metadata?.resume).toEqual({
    project: "radar-immobilier",
    cwd: "/home/antoinefa/src/radar-immobilier",
  });
  expect(session.cliSessionId).toBe("conv-123");
  expect(session.updatedAt).toBeDefined();
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w @sentropic/remote-control-plane -- src/index.test.ts`

Expected: FAIL because `SessionDescriptor` does not yet expose `startedAt` / `updatedAt`, and list/get callbacks do not preserve those fields.

- [ ] **Step 3: Add timestamp fields and stamp descriptor writes**

```ts
// packages/protocol/src/schemas/session.ts
required: [
  "id",
  "profile",
  "target",
  "workspacePath",
  "createdAt",
  "createdBy",
  "startedAt",
  "updatedAt",
],
properties: {
  id: { type: "string", minLength: 1 },
  profile: embeddedCliProfileSchema,
  target: embeddedSessionTargetSchema,
  workspacePath: { type: "string", const: "/workspace" },
  workspaceId: { type: "string", minLength: 1 },
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  cliSessionId: {
    type: "string",
    minLength: 1,
  },
  displayName: { type: "string", minLength: 1 },
  labels: labelsSchema,
  resourceLimits: embeddedResourceLimitsSchema,
  requiredCapabilities: {
    type: "array",
    items: embeddedCapabilitySchema,
    uniqueItems: true,
  },
  metadata: metadataSchema,
}
```

```ts
// apps/control-plane/src/sessions/store.ts
export class SessionStore {
  private readonly sessions = new Map<string, SessionDescriptor>();
  private readonly owners = new Map<string, string>();

  put(descriptor: SessionDescriptor, userId?: string): SessionDescriptor {
    const previous = this.sessions.get(descriptor.id);
    const createdAt = previous?.createdAt ?? descriptor.createdAt;
    const startedAt = previous?.startedAt ?? descriptor.startedAt ?? createdAt;
    const stamped: SessionDescriptor = {
      ...previous,
      ...descriptor,
      createdAt,
      startedAt,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(stamped.id, stamped);
    if (userId !== undefined) this.owners.set(stamped.id, userId);
    return stamped;
  }
}
```

```ts
// apps/control-plane/src/routes/sessions.ts
function buildDescriptor(
  req: CreateSessionRequest & { workspaceId?: string },
): SessionDescriptor {
  const now = new Date().toISOString();
  const descriptor: SessionDescriptor = {
    id: randomId("sess"),
    profile: req.profile,
    target: req.target,
    workspacePath: "/workspace",
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    createdBy: {
      id: "control-plane",
      kind: "control-plane",
      displayName: "Control Plane",
    },
  };
  if (req.workspaceId !== undefined) descriptor.workspaceId = req.workspaceId;
  if (req.displayName !== undefined) descriptor.displayName = req.displayName;
  if (req.labels !== undefined) descriptor.labels = req.labels;
  if (req.resourceLimits !== undefined) descriptor.resourceLimits = req.resourceLimits;
  if (req.requiredCapabilities !== undefined) {
    descriptor.requiredCapabilities = req.requiredCapabilities;
  }
  if (req.metadata !== undefined) descriptor.metadata = req.metadata;
  return descriptor;
}

if (typeof body.cliSessionId === "string" && body.cliSessionId.length > 0) {
  store.put({ ...session, cliSessionId: body.cliSessionId }, userId);
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w @sentropic/remote-control-plane -- src/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/protocol/src/schemas/session.ts \
  apps/control-plane/src/sessions/store.ts \
  apps/control-plane/src/routes/sessions.ts \
  apps/control-plane/src/index.test.ts
git commit -m "feat(protocol): stamp session resume timestamps"
```

### Task 3: Rich Remote Session Summaries and Migration Pairing Metadata

**Files:**
- Modify: `packages/remote-cli/src/attach.ts:297-436`
- Modify: `packages/remote-cli/src/attach.test.ts:1-260, 507-537`
- Modify: `packages/remote-cli/src/migrate.ts:52-121, 346-541`
- Modify: `packages/remote-cli/src/migrate.test.ts:1-587`

- [ ] **Step 1: Write the failing CLI transport and migrate tests**

```ts
// packages/remote-cli/src/attach.test.ts
it("listRemoteSessions returns workspaceId, timestamps, and resume metadata", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        sessions: [
          {
            id: "sess-1",
            profile: "claude",
            target: "k3s",
            createdAt: "2026-06-01T00:00:00Z",
            startedAt: "2026-06-01T00:00:00Z",
            updatedAt: "2026-06-01T00:05:00Z",
            workspaceId: "ws-1",
            displayName: "radar-immobilier",
            cliSessionId: "conv-1",
            metadata: {
              resume: {
                project: "radar-immobilier",
              },
            },
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  const [session] = await listRemoteSessions("http://localhost:8080", fetchImpl);
  expect(session.workspaceId).toBe("ws-1");
  expect(session.updatedAt).toBe("2026-06-01T00:05:00Z");
  expect(session.metadata?.resume).toEqual({ project: "radar-immobilier" });
});
```

```ts
// packages/remote-cli/src/migrate.test.ts
it("migrateForward includes pairing metadata and displayName on the main session", async () => {
  const stderr = stubStream();
  const capturedBodies: Array<Record<string, unknown>> = [];

  mockCreateRemoteSession.mockImplementation((_url: string, body: Record<string, unknown>) => {
    capturedBodies.push(body);
    if (body.workspaceSync && body.profile === "shell")
      return Promise.resolve({ id: PUSH_SESSION_ID });
    return Promise.resolve({ id: SESSION_ID });
  });

  await migrateForward({
    profile: "claude",
    remoteUrl: REMOTE_URL,
    cwd: makeTempCwd("forward-metadata"),
    stderr,
  });

  const main = capturedBodies.find((body) => body.profile === "claude")!;
  expect(main.displayName).toBe("forward-metadata");
  expect(main.metadata).toMatchObject({
    resume: {
      profile: "claude",
      project: "forward-metadata",
    },
  });
});

it("migrateBack stops the session bound to the requested workspace instead of the newest session", async () => {
  mockListRemoteSessions.mockResolvedValue([
    {
      id: "sess-other",
      profile: "claude",
      target: "k3s",
      createdAt: "2026-06-01T00:10:00Z",
      startedAt: "2026-06-01T00:10:00Z",
      updatedAt: "2026-06-01T00:10:00Z",
      workspaceId: "ws-other",
    },
    {
      id: "sess-right",
      profile: "claude",
      target: "k3s",
      createdAt: "2026-06-01T00:05:00Z",
      startedAt: "2026-06-01T00:05:00Z",
      updatedAt: "2026-06-01T00:05:00Z",
      workspaceId: WORKSPACE_ID,
    },
  ]);

  await migrateBack({
    remoteUrl: REMOTE_URL,
    workspaceId: WORKSPACE_ID,
    cwd: makeTempCwd("back-workspace-target"),
  });

  expect(mockStopRemoteSession).toHaveBeenCalledWith(
    REMOTE_URL,
    "sess-right",
    "migrate-back",
    expect.any(Function),
  );
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w @sentropic/remote-cli -- src/attach.test.ts src/migrate.test.ts`

Expected: FAIL because `listRemoteSessions()` drops `workspaceId`/`metadata`, `migrateForward()` emits no resume metadata, and `migrateBack()` still stops the newest session.

- [ ] **Step 3: Add the richer summary type and pairing metadata hooks**

```ts
// packages/remote-cli/src/attach.ts
export type RemoteSessionSummary = {
  id: string;
  profile: string;
  target: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  displayName?: string;
  cliSessionId?: string;
  workspaceId?: string;
  metadata?: Readonly<Record<string, unknown>>;
};

export async function listRemoteSessions(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlyArray<RemoteSessionSummary>> {
  const response = await fetchImpl(joinUrl(baseUrl, "/sessions"), {
    headers: { ...authHeaders() },
  });
  if (!response.ok) {
    throw new Error(`listRemoteSessions: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { sessions: RemoteSessionSummary[] };
  return json.sessions;
}

export async function createRemoteSession(
  baseUrl: string,
  body: {
    profile: string;
    target?: string;
    startupArgs?: readonly string[];
    displayName?: string;
    credentials?: Readonly<Record<string, string>>;
    metadata?: Readonly<Record<string, unknown>>;
    workspaceSync?: boolean;
    workspaceExport?: boolean;
    workspaceId?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const payload: Record<string, unknown> = {
    profile: body.profile,
    target: body.target ?? "k3s",
  };
  if (body.displayName) payload.displayName = body.displayName;
  if (body.workspaceId) payload.workspaceId = body.workspaceId;
  if (body.metadata !== undefined || body.startupArgs !== undefined) {
    payload.metadata = {
      ...(body.metadata ?? {}),
      ...(body.startupArgs !== undefined
        ? { startup: { args: [...body.startupArgs] } }
        : {}),
    };
  }
  if (body.workspaceSync) payload.workspaceSync = true;
  if (body.workspaceExport) payload.workspaceExport = true;
  if (body.credentials) payload.credentials = body.credentials;
  const response = await fetchImpl(joinUrl(baseUrl, "/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `createRemoteSession: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as { session: { id: string } };
  return { id: json.session.id };
}
```

```ts
// packages/remote-cli/src/migrate.ts
export type MigrateForwardOptions = {
  readonly profile: string;
  readonly remoteUrl: string;
  readonly workspaceId?: string;
  readonly resume?: string | true;
  readonly displayName?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly noAttach?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly cwd?: string;
  readonly stderr?: NodeJS.WriteStream;
};

const projectName = cwd.split("/").filter(Boolean).at(-1) ?? profile;
const session = await createRemoteSession(
  remoteUrl,
  {
    profile,
    workspaceId: marker.workspaceId,
    workspaceSync: true,
    displayName: options.displayName ?? projectName,
    metadata: {
      resume: {
        project: projectName,
        cwd,
        profile,
        ...(options.resume !== undefined ? { conversationHint: options.resume } : {}),
        ...(options.metadata ?? {}),
      },
    },
    ...(credentials ? { credentials } : {}),
    ...(resumeArgs.length > 0 ? { startupArgs: resumeArgs } : {}),
  },
  fetchImpl,
);

const target = sessions
  .filter((session) => session.workspaceId === workspaceId)
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
if (target) {
  await stopRemoteSession(remoteUrl, target.id, "migrate-back", fetchImpl);
  stoppedSessionId = target.id;
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w @sentropic/remote-cli -- src/attach.test.ts src/migrate.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/remote-cli/src/attach.ts \
  packages/remote-cli/src/attach.test.ts \
  packages/remote-cli/src/migrate.ts \
  packages/remote-cli/src/migrate.test.ts
git commit -m "feat(cli): enrich remote session resume metadata"
```

### Task 4: Candidate Discovery and Canonicalization

**Files:**
- Create: `packages/remote-cli/src/resume/discovery.ts`
- Create: `packages/remote-cli/src/resume/discovery.test.ts`
- Modify: `packages/remote-cli/src/resume/types.ts`

- [ ] **Step 1: Write the failing discovery tests**

```ts
// packages/remote-cli/src/resume/discovery.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ResumeEnvironment, RemoteSessionSummary } from "./types.js";
import { discoverCandidates } from "./discovery.js";

function writeJsonl(path: string, rows: unknown[]) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

const env: ResumeEnvironment = {
  version: 1,
  name: "dev",
  terminal: {
    app: "gnome-terminal",
    maxWindows: 4,
    maxTabsPerWindow: 12,
    titleTemplate: "{project} [{profile} {place} {state}]",
  },
  inventory: { localLookbackHours: 48, profiles: ["claude", "codex"], remoteUrl: "default" },
  layout: { groups: [], sharedWindows: 2 },
  projects: {
    "radar-immobilier": {
      maxSessions: 1,
      roots: ["/home/antoinefa/src/radar-immobilier"],
    },
  },
};

describe("discoverCandidates", () => {
  it("canonicalizes local cwd by configured roots and keeps a running local session as status-only", async () => {
    const home = "/tmp/resume-home";
    writeJsonl(
      `${home}/.claude/projects/-home-antoinefa-src-radar-immobilier/session.jsonl`,
      [
        { type: "user", cwd: "/home/antoinefa/src/radar-immobilier" },
        { type: "assistant", conversationId: "conv-local" },
      ],
    );

    const candidates = await discoverCandidates({
      env,
      home,
      now: new Date("2026-06-01T12:00:00Z"),
      listRemoteSessions: async () => [],
      listProcesses: async () => [
        {
          pid: 42,
          cwd: "/home/antoinefa/src/radar-immobilier",
          profile: "claude",
          conversationId: "conv-local",
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.project).toBe("radar-immobilier");
    expect(candidates[0]!.launchMode).toBe("status-only");
    expect(candidates[0]!.state).toBe("run");
  });

  it("pairs local and remote evidence only when workspace/metadata evidence agrees", async () => {
    const remoteSessions: RemoteSessionSummary[] = [
      {
        id: "sess-1",
        profile: "claude",
        target: "k3s",
        createdAt: "2026-06-01T10:00:00Z",
        startedAt: "2026-06-01T10:00:00Z",
        updatedAt: "2026-06-01T11:00:00Z",
        workspaceId: "ws-1",
        metadata: {
          resume: {
            project: "radar-immobilier",
            cwd: "/home/antoinefa/src/radar-immobilier",
          },
        },
      },
    ];

    const [candidate] = await discoverCandidates({
      env,
      home: "/tmp/empty-home",
      now: new Date("2026-06-01T12:00:00Z"),
      listRemoteSessions: async () => remoteSessions,
      listProcesses: async () => [],
    });

    expect(candidate.place).toBe("remote");
    expect(candidate.project).toBe("radar-immobilier");
    expect(candidate.launchMode).toBe("remote-attach");
  });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w @sentropic/remote-cli -- src/resume/discovery.test.ts`

Expected: FAIL because `discoverCandidates()` does not exist yet and the candidate type has no `launchMode`.

- [ ] **Step 3: Implement candidate discovery, pairing, and launch-mode selection**

```ts
// packages/remote-cli/src/resume/types.ts
export type RemoteSessionSummary = import("../attach.js").RemoteSessionSummary;

export type ResumeCandidate = {
  id: string;
  project: string;
  cwd: string;
  profile: string;
  conversationId?: string;
  workspaceId?: string;
  remoteUrl?: string;
  remoteSessionId?: string;
  place: "local" | "remote" | "both";
  launchMode: "local-resume" | "remote-attach" | "status-only";
  state: "run" | "wait" | "recent" | "stale" | "done" | "err";
  activityAt: string;
  displayName: string;
  metadata?: Readonly<Record<string, unknown>>;
};
```

```ts
// packages/remote-cli/src/resume/discovery.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { listRemoteSessions, type RemoteSessionSummary } from "../attach.js";
import { getDefaultRemote } from "../config.js";
import { readWorkspaceMarker } from "../workspace.js";
import type { ResumeCandidate, ResumeEnvironment } from "./types.js";

type DiscoveryOptions = {
  env: ResumeEnvironment;
  home?: string;
  now?: Date;
  prefer?: "local" | "remote" | "newest";
  listRemoteSessions?: typeof listRemoteSessions;
  listProcesses?: () => Promise<
    ReadonlyArray<{
      pid: number;
      cwd: string;
      profile: string;
      conversationId?: string;
    }>
  >;
};

function canonicalProject(
  env: ResumeEnvironment,
  cwd: string,
  metadataProject?: string,
): string {
  for (const [project, cfg] of Object.entries(env.projects)) {
    for (const root of cfg.roots ?? []) {
      if (cwd === root || cwd.startsWith(`${root}/`)) return project;
    }
  }
  if (metadataProject) return metadataProject;
  return basename(cwd);
}

function walkJsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonlFiles(path));
      continue;
    }
    if (entry.isFile() && path.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function selectLaunchMode(args: {
  localRunning: boolean;
  hasRemote: boolean;
  hasLocalResume: boolean;
  prefer: "local" | "remote" | "newest";
  localActivityAt?: string;
  remoteActivityAt?: string;
}): "local-resume" | "remote-attach" | "status-only" {
  if (args.localRunning) return "status-only";
  if (args.prefer === "remote" && args.hasRemote) return "remote-attach";
  if (args.prefer === "local" && args.hasLocalResume) return "local-resume";
  if (args.prefer === "newest") {
    const localAt = args.localActivityAt ?? "";
    const remoteAt = args.remoteActivityAt ?? "";
    if (args.hasRemote && remoteAt >= localAt) return "remote-attach";
    if (args.hasLocalResume) return "local-resume";
  }
  if (args.hasRemote) return "remote-attach";
  return args.hasLocalResume ? "local-resume" : "status-only";
}

export async function discoverCandidates(
  options: DiscoveryOptions,
): Promise<ResumeCandidate[]> {
  const home = options.home ?? (process.env.HOME ?? "");
  const now = options.now ?? new Date();
  const prefer = options.prefer ?? "remote";
  const remoteUrl =
    options.env.inventory.remoteUrl === "default"
      ? getDefaultRemote()
      : options.env.inventory.remoteUrl;
  const remoteSessions = remoteUrl
    ? await (options.listRemoteSessions ?? listRemoteSessions)(remoteUrl)
    : [];
  const processes = await (options.listProcesses?.() ?? Promise.resolve([]));
  const localCandidates: ResumeCandidate[] = [];

  const localRoots = [
    join(home, ".claude", "projects"),
    join(home, ".codex", "sessions"),
  ];
  for (const root of localRoots) {
    if (!existsSync(root)) continue;
    for (const path of walkJsonlFiles(root)) {
      const raw = readFileSync(path, "utf8").trim();
      if (!raw) continue;
      const lines = raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const cwd =
        (lines.find((line) => typeof line.cwd === "string")?.cwd as string | undefined) ??
        (lines[0]?.payload as { cwd?: string } | undefined)?.cwd ??
        "";
      if (!cwd) continue;
      const stats = statSync(path);
      const activityAt = stats.mtime.toISOString();
      const withinLookback =
        now.getTime() - stats.mtime.getTime() <=
        options.env.inventory.localLookbackHours * 60 * 60 * 1000;
      const metadataProject = undefined;
      const project = canonicalProject(options.env, cwd, metadataProject);
      const profile = path.includes(`${home}/.claude/`) ? "claude" : "codex";
      const conversationId =
        (lines.find((line) => typeof line.conversationId === "string")?.conversationId as string | undefined) ??
        (lines[0]?.payload as { id?: string } | undefined)?.id;
      const marker = readWorkspaceMarker(cwd);
      const lastUser = lines.map((line, index) => ({ line, index }))
        .filter(({ line }) => line.type === "user")
        .at(-1)?.index ?? -1;
      const lastAssistant = lines.map((line, index) => ({ line, index }))
        .filter(({ line }) => line.type === "assistant")
        .at(-1)?.index ?? -1;
      const localRunning = processes.some(
        (proc) =>
          proc.cwd === cwd &&
          proc.profile === profile &&
          (conversationId === undefined || proc.conversationId === conversationId),
      );
      localCandidates.push({
        id: `${profile}:${conversationId ?? activityAt}:${cwd}`,
        project,
        cwd,
        profile,
        conversationId,
        workspaceId: marker?.workspaceId,
        place: "local",
        launchMode: localRunning ? "status-only" : "local-resume",
        state: localRunning
          ? "run"
          : lastAssistant > lastUser
            ? "wait"
            : withinLookback
              ? "recent"
              : "stale",
        activityAt,
        displayName: `${project}${conversationId ? `#${conversationId}` : ""}`,
      });
    }
  }

  const remoteCandidates = remoteSessions.map((session) => {
    const resumeMeta = (session.metadata?.resume ?? {}) as {
      project?: string;
      cwd?: string;
    };
    const cwd = resumeMeta.cwd ?? `/workspaces/${session.workspaceId ?? session.id}`;
    return {
      id: session.id,
      project: canonicalProject(options.env, cwd, resumeMeta.project),
      cwd,
      profile: session.profile,
      workspaceId: session.workspaceId,
      remoteUrl,
      remoteSessionId: session.id,
      place: "remote" as const,
      launchMode: "remote-attach" as const,
      state:
        now.getTime() - new Date(session.updatedAt).getTime() <=
        options.env.inventory.localLookbackHours * 60 * 60 * 1000
          ? ("run" as const)
          : ("stale" as const),
      activityAt: session.updatedAt,
      displayName: session.displayName ?? `${session.profile}:${session.id}`,
      metadata: session.metadata,
    };
  });

  const paired = new Map<string, ResumeCandidate>();
  for (const candidate of localCandidates) {
    paired.set(candidate.id, candidate);
  }
  for (const remote of remoteCandidates) {
    const match = localCandidates.find(
      (local) =>
        local.profile === remote.profile &&
        (
          (local.workspaceId !== undefined &&
            local.workspaceId === remote.workspaceId) ||
          (local.cwd === remote.cwd && local.project === remote.project)
        ),
    );
    if (!match) {
      paired.set(remote.id, remote);
      continue;
    }
    paired.set(match.id, {
      ...match,
      place: "both",
      workspaceId: remote.workspaceId,
      remoteUrl: remote.remoteUrl,
      remoteSessionId: remote.remoteSessionId,
      metadata: remote.metadata,
      activityAt:
        remote.activityAt >= match.activityAt ? remote.activityAt : match.activityAt,
      launchMode: selectLaunchMode({
        localRunning: match.launchMode === "status-only",
        hasRemote: true,
        hasLocalResume: match.conversationId !== undefined,
        prefer,
        localActivityAt: match.activityAt,
        remoteActivityAt: remote.activityAt,
      }),
      state: match.launchMode === "status-only" ? "run" : remote.state,
    });
  }

  return [...paired.values()].sort((a, b) => b.activityAt.localeCompare(a.activityAt));
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w @sentropic/remote-cli -- src/resume/discovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/remote-cli/src/resume/types.ts \
  packages/remote-cli/src/resume/discovery.ts \
  packages/remote-cli/src/resume/discovery.test.ts
git commit -m "feat(cli): discover resume candidates across local and remote"
```

### Task 5: Layout Planning and Overflow Ordering

**Files:**
- Create: `packages/remote-cli/src/resume/layout.ts`
- Create: `packages/remote-cli/src/resume/layout.test.ts`
- Modify: `packages/remote-cli/src/resume/types.ts`

- [ ] **Step 1: Write the failing layout tests**

```ts
// packages/remote-cli/src/resume/layout.test.ts
import { describe, expect, it } from "vitest";

import type { ResumeCandidate, ResumeEnvironment } from "./types.js";
import { planLayout } from "./layout.js";

const env: ResumeEnvironment = {
  version: 1,
  name: "dev",
  terminal: {
    app: "gnome-terminal",
    maxWindows: 4,
    maxTabsPerWindow: 12,
    titleTemplate: "{project} [{profile} {place} {state}]",
  },
  inventory: { localLookbackHours: 48, profiles: ["claude"], remoteUrl: "default" },
  layout: {
    groups: [
      { name: "sentropic", projects: ["sentropic"], slots: 2 },
      { name: "design + h2a", projects: ["remote"], slots: 1 },
    ],
    sharedWindows: 1,
  },
  projects: {
    sentropic: { maxSessions: 12 },
    remote: { maxSessions: 4 },
    "radar-immobilier": { maxSessions: 1 },
  },
};

const candidates: ResumeCandidate[] = [
  {
    id: "a",
    project: "sentropic",
    cwd: "/src/sentropic",
    profile: "claude",
    place: "remote",
    launchMode: "remote-attach",
    state: "wait",
    activityAt: "2026-06-01T12:00:00Z",
    displayName: "sentropic#01",
    remoteUrl: "http://remote.test:8080",
    remoteSessionId: "sess-a",
  },
  {
    id: "b",
    project: "sentropic",
    cwd: "/src/sentropic",
    profile: "claude",
    place: "remote",
    launchMode: "remote-attach",
    state: "recent",
    activityAt: "2026-06-01T11:00:00Z",
    displayName: "sentropic#02",
    remoteUrl: "http://remote.test:8080",
    remoteSessionId: "sess-b",
  },
  {
    id: "c",
    project: "remote",
    cwd: "/src/remote",
    profile: "claude",
    place: "local",
    launchMode: "local-resume",
    state: "recent",
    activityAt: "2026-06-01T10:00:00Z",
    displayName: "remote#01",
    conversationId: "conv-c",
  },
  {
    id: "d",
    project: "radar-immobilier",
    cwd: "/src/radar-immobilier",
    profile: "claude",
    place: "remote",
    launchMode: "remote-attach",
    state: "run",
    activityAt: "2026-06-01T09:00:00Z",
    displayName: "radar-immobilier",
    remoteUrl: "http://remote.test:8080",
    remoteSessionId: "sess-d",
  },
];

describe("planLayout", () => {
  it("allocates explicit groups first, then shared windows, and reports no overflow when capacity fits", () => {
    const plan = planLayout(env, candidates);
    expect(plan.windows).toHaveLength(3);
    expect(plan.windows[0]!.name).toBe("sentropic");
    expect(plan.windows[0]!.tabs.map((tab) => tab.slotId)).toEqual(["a", "b"]);
    expect(plan.windows[1]!.tabs.map((tab) => tab.slotId)).toEqual(["c"]);
    expect(plan.windows[2]!.tabs.map((tab) => tab.slotId)).toEqual(["d"]);
    expect(plan.overflow).toEqual([]);
  });

  it("enforces per-project maxSessions unless --all is requested", () => {
    const withOverflow = planLayout(env, [
      ...candidates,
      {
        id: "e",
        project: "radar-immobilier",
        cwd: "/src/radar-immobilier",
        profile: "claude",
        place: "remote",
        launchMode: "remote-attach",
        state: "recent",
        activityAt: "2026-06-01T08:00:00Z",
        displayName: "radar-immobilier#02",
        remoteUrl: "http://remote.test:8080",
        remoteSessionId: "sess-e",
      },
    ]);
    expect(withOverflow.overflow.map((candidate) => candidate.id)).toContain("e");

    const withoutLimit = planLayout(
      env,
      [
        ...candidates,
        {
          id: "e",
          project: "radar-immobilier",
          cwd: "/src/radar-immobilier",
          profile: "claude",
          place: "remote",
          launchMode: "remote-attach",
          state: "recent",
          activityAt: "2026-06-01T08:00:00Z",
          displayName: "radar-immobilier#02",
          remoteUrl: "http://remote.test:8080",
          remoteSessionId: "sess-e",
        },
      ],
      { ignoreProjectLimits: true },
    );
    expect(withoutLimit.overflow.map((candidate) => candidate.id)).not.toContain("e");
  });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w @sentropic/remote-cli -- src/resume/layout.test.ts`

Expected: FAIL because `planLayout()` does not exist yet.

- [ ] **Step 3: Implement deterministic layout planning**

```ts
// packages/remote-cli/src/resume/types.ts
export type LaunchTab = {
  slotId: string;
  windowName: string;
  cwd: string;
  title: string;
  command: "local-resume" | "remote-attach";
  candidate: ResumeCandidate;
};

export type LaunchWindow = {
  name: string;
  tabs: LaunchTab[];
};

export type LayoutPlan = {
  windows: LaunchWindow[];
  overflow: ResumeCandidate[];
  statusOnly: ResumeCandidate[];
};
```

```ts
// packages/remote-cli/src/resume/layout.ts
import type {
  LayoutPlan,
  LaunchTab,
  LaunchWindow,
  ResumeCandidate,
  ResumeEnvironment,
} from "./types.js";

const STATE_PRIORITY: Record<ResumeCandidate["state"], number> = {
  wait: 0,
  run: 1,
  recent: 2,
  stale: 3,
  done: 4,
  err: 5,
};

function compareCandidates(a: ResumeCandidate, b: ResumeCandidate): number {
  const launchPriority = (candidate: ResumeCandidate) =>
    candidate.launchMode === "remote-attach" ? 0 : 1;
  return (
    launchPriority(a) - launchPriority(b) ||
    STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] ||
    b.activityAt.localeCompare(a.activityAt) ||
    a.project.localeCompare(b.project) ||
    a.displayName.localeCompare(b.displayName)
  );
}

export function planLayout(
  env: ResumeEnvironment,
  candidates: ResumeCandidate[],
  options: { ignoreProjectLimits?: boolean } = {},
): LayoutPlan {
  const projectOverflow: ResumeCandidate[] = [];
  const projectCounts = new Map<string, number>();
  const limited = candidates.filter((candidate) => {
    if (options.ignoreProjectLimits) return true;
    const limit = env.projects[candidate.project]?.maxSessions;
    if (limit === undefined) return true;
    const next = (projectCounts.get(candidate.project) ?? 0) + 1;
    if (next > limit) {
      projectOverflow.push(candidate);
      return false;
    }
    projectCounts.set(candidate.project, next);
    return true;
  });

  const launchable = limited
    .filter((candidate) => candidate.launchMode !== "status-only")
    .sort(compareCandidates);
  const statusOnly = limited.filter((candidate) => candidate.launchMode === "status-only");

  const windows: LaunchWindow[] = [];
  const remaining = [...launchable];

  for (const group of env.layout.groups) {
    const capacity = group.slots ?? env.terminal.maxTabsPerWindow;
    const tabs = remaining
      .filter((candidate) => group.projects.includes(candidate.project))
      .slice(0, capacity)
      .map<LaunchTab>((candidate) => ({
        slotId: candidate.id,
        windowName: group.name,
        cwd: candidate.cwd,
        title: `${candidate.project} [${candidate.profile} ${candidate.place} ${candidate.state}]`,
        command: candidate.launchMode,
        candidate,
      }));
    for (const tab of tabs) {
      const index = remaining.findIndex((candidate) => candidate.id === tab.slotId);
      if (index >= 0) remaining.splice(index, 1);
    }
    windows.push({ name: group.name, tabs });
  }

  for (let i = 0; i < env.layout.sharedWindows; i++) {
    windows.push({
      name: `shared-${i + 1}`,
      tabs: remaining.splice(0, env.terminal.maxTabsPerWindow).map((candidate) => ({
        slotId: candidate.id,
        windowName: `shared-${i + 1}`,
        cwd: candidate.cwd,
        title: `${candidate.project} [${candidate.profile} ${candidate.place} ${candidate.state}]`,
        command: candidate.launchMode,
        candidate,
      })),
    });
  }

  return {
    windows,
    overflow: [...projectOverflow, ...remaining],
    statusOnly,
  };
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w @sentropic/remote-cli -- src/resume/layout.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/remote-cli/src/resume/types.ts \
  packages/remote-cli/src/resume/layout.ts \
  packages/remote-cli/src/resume/layout.test.ts
git commit -m "feat(cli): plan remote resume terminal layouts"
```

### Task 6: Terminal Launcher and Internal `run-tab`

**Files:**
- Create: `packages/remote-cli/src/resume/launcher.ts`
- Create: `packages/remote-cli/src/resume/launcher.test.ts`
- Modify: `packages/remote-cli/src/resume/types.ts`

- [ ] **Step 1: Write the failing launcher tests**

```ts
// packages/remote-cli/src/resume/launcher.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LayoutPlan } from "./types.js";
import {
  buildGnomeTerminalArgs,
  renderTitle,
  runTabFromMap,
  writeLaunchArtifacts,
} from "./launcher.js";

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function makePlan(): LayoutPlan {
  return {
    statusOnly: [],
    overflow: [],
    windows: [
      {
        name: "shared-1",
        tabs: [
          {
            slotId: "slot-1",
            windowName: "shared-1",
            cwd: "/home/antoinefa/src/remote",
            title: "remote [claude R wait]",
            command: "remote-attach",
            candidate: {
              id: "slot-1",
              project: "remote",
              cwd: "/home/antoinefa/src/remote",
              profile: "claude",
              place: "remote",
              launchMode: "remote-attach",
              state: "wait",
              activityAt: "2026-06-01T12:00:00Z",
              displayName: "remote#01",
              remoteUrl: "http://remote.test:8080",
              remoteSessionId: "sess-1",
            },
          },
        ],
      },
    ],
  };
}

describe("launcher", () => {
  it("writes a map and one wrapper script per launch slot", () => {
    scratch = mkdtempSync(join(tmpdir(), "remote-launcher-"));
    const artifacts = writeLaunchArtifacts(makePlan(), scratch);
    expect(artifacts.mapPath).toMatch(/launch-map\.json$/);
    expect(artifacts.slotScripts).toHaveLength(1);
    const script = readFileSync(artifacts.slotScripts[0]!, "utf8");
    expect(script).toContain("remote resume run-tab");
    expect(script).toContain("--slot slot-1");
  });

  it("renders titles from the plan template", () => {
    expect(
      renderTitle("{project} [{profile} {place} {state}]", {
        project: "radar-immobilier",
        profile: "claude",
        place: "R",
        state: "run",
      }),
    ).toBe("radar-immobilier [claude R run]");
  });

  it("builds gnome-terminal args with one wrapper command per tab", () => {
    scratch = mkdtempSync(join(tmpdir(), "remote-launcher-"));
    const artifacts = writeLaunchArtifacts(makePlan(), scratch);
    const args = buildGnomeTerminalArgs(makePlan(), artifacts);
    expect(args.join(" ")).toContain("--window");
    expect(args.join(" ")).toContain("--tab");
    expect(args.join(" ")).toContain(artifacts.slotScripts[0]!);
  });

  it("runTabFromMap executes only the bound slot command when cwd matches", async () => {
    scratch = mkdtempSync(join(tmpdir(), "remote-launcher-"));
    const artifacts = writeLaunchArtifacts(makePlan(), scratch);
    const spawnCommand = vi.fn();
    await runTabFromMap(artifacts.mapPath, "slot-1", {
      cwd: "/home/antoinefa/src/remote",
      spawnCommand,
    });
    expect(spawnCommand).toHaveBeenCalledWith("remote", [
      "attach",
      "http://remote.test:8080",
      "sess-1",
    ]);
  });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w @sentropic/remote-cli -- src/resume/launcher.test.ts`

Expected: FAIL because the launcher module and slot-script generation do not exist yet.

- [ ] **Step 3: Implement launch-map writing, wrapper scripts, and title rendering**

```ts
// packages/remote-cli/src/resume/launcher.ts
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { LayoutPlan } from "./types.js";

export type LaunchArtifacts = {
  mapPath: string;
  slotScripts: string[];
};

export function renderTitle(
  template: string,
  data: { project: string; profile: string; place: string; state: string },
): string {
  return template
    .replaceAll("{project}", data.project)
    .replaceAll("{profile}", data.profile)
    .replaceAll("{place}", data.place)
    .replaceAll("{state}", data.state);
}

export function writeLaunchArtifacts(plan: LayoutPlan, root: string): LaunchArtifacts {
  mkdirSync(root, { recursive: true });
  const mapPath = join(root, "launch-map.json");
  writeFileSync(mapPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  const slotScripts: string[] = [];
  for (const window of plan.windows) {
    for (const tab of window.tabs) {
      const scriptPath = join(root, `${tab.slotId}.sh`);
      writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `cd ${JSON.stringify(tab.cwd)}`,
          `exec remote resume run-tab --map ${JSON.stringify(mapPath)} --slot ${JSON.stringify(tab.slotId)}`,
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(scriptPath, 0o755);
      slotScripts.push(scriptPath);
    }
  }
  return { mapPath, slotScripts };
}

export function buildGnomeTerminalArgs(
  plan: LayoutPlan,
  artifacts: LaunchArtifacts,
): string[] {
  const args: string[] = [];
  let scriptIndex = 0;
  for (const window of plan.windows) {
    for (const [tabIndex, tab] of window.tabs.entries()) {
      args.push(tabIndex === 0 ? "--window" : "--tab");
      args.push("--working-directory", tab.cwd);
      args.push("--title", tab.title);
      args.push("--", artifacts.slotScripts[scriptIndex]!);
      scriptIndex += 1;
    }
  }
  return args;
}

export async function runTabFromMap(
  mapPath: string,
  slotId: string,
  io: {
    stderr?: NodeJS.WriteStream;
    cwd?: string;
    spawnCommand?: (command: string, args: string[]) => void;
  } = {},
): Promise<void> {
  const plan = JSON.parse(readFileSync(mapPath, "utf8")) as LayoutPlan;
  const tab = plan.windows.flatMap((window) => window.tabs).find((entry) => entry.slotId === slotId);
  if (!tab) throw new Error(`Unknown launch slot ${slotId}`);
  const actualCwd = io.cwd ?? process.cwd();
  if (actualCwd !== tab.cwd) {
    throw new Error(`Launch slot ${slotId} expected cwd ${tab.cwd} but got ${actualCwd}`);
  }
  io.stderr?.write(`\u001b]0;${tab.title}\u0007`);
  const spawnCommand =
    io.spawnCommand ??
    ((command: string, args: string[]) => {
      const result = spawnSync(command, args, { stdio: "inherit" });
      if (result.status && result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status}`);
      }
    });
  if (tab.command === "local-resume") {
    spawnCommand("remote", [
      tab.candidate.profile,
      "--local",
      "--resume",
      tab.candidate.conversationId!,
    ]);
    return;
  }
  spawnCommand("remote", [
    "attach",
    tab.candidate.remoteUrl!,
    tab.candidate.remoteSessionId!,
  ]);
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w @sentropic/remote-cli -- src/resume/launcher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/remote-cli/src/resume/types.ts \
  packages/remote-cli/src/resume/launcher.ts \
  packages/remote-cli/src/resume/launcher.test.ts
git commit -m "feat(cli): add remote resume terminal launcher"
```

### Task 7: Commander Wiring, JSON Reports, and User Docs

**Files:**
- Modify: `packages/remote-cli/src/index.ts:7-20, 63-104, 900-1060`
- Modify: `packages/remote-cli/src/index.test.ts:1-453`
- Create: `docs/remote-resume.md`

- [ ] **Step 1: Write the failing CLI integration tests**

```ts
// packages/remote-cli/src/index.test.ts
const initEnvironment = vi.fn();
const listEnvironments = vi.fn();
const readEnvironment = vi.fn();
const validateEnvironment = vi.fn();
const discoverCandidates = vi.fn();
const planLayout = vi.fn();
const writeLaunchArtifacts = vi.fn();
const buildGnomeTerminalArgs = vi.fn();
const runTabFromMap = vi.fn();

vi.mock("./resume/environment.js", () => ({
  editEnvironment: vi.fn((env: string) => `/tmp/${env}.json`),
  initEnvironment,
  listEnvironments,
  readEnvironment,
  validateEnvironment,
}));

vi.mock("./resume/discovery.js", () => ({
  discoverCandidates,
}));

vi.mock("./resume/layout.js", () => ({
  planLayout,
}));

vi.mock("./resume/launcher.js", () => ({
  writeLaunchArtifacts,
  buildGnomeTerminalArgs,
  runTabFromMap,
}));

it("remote env init dev materializes the default environment", async () => {
  initEnvironment.mockReturnValue({ name: "dev" });
  const exitCode = await main(["node", "remote", "env", "init", "dev"]);
  expect(exitCode).toBe(0);
  expect(initEnvironment).toHaveBeenCalledWith("dev");
});

it("remote resume dev --dry-run --json prints the report and never launches terminals", async () => {
  readEnvironment.mockReturnValue({ name: "dev" });
  validateEnvironment.mockReturnValue([]);
  discoverCandidates.mockResolvedValue([]);
  planLayout.mockReturnValue({ windows: [], overflow: [], statusOnly: [] });

  const exitCode = await main([
    "node",
    "remote",
    "resume",
    "dev",
    "--dry-run",
    "--json",
  ]);

  expect(exitCode).toBe(0);
  expect(buildGnomeTerminalArgs).not.toHaveBeenCalled();
});

it("remote resume dev --json without --dry-run or --status fails fast", async () => {
  await expect(
    main(["node", "remote", "resume", "dev", "--json"]),
  ).rejects.toThrow(/--json is only valid with --dry-run or --status/);
});

it("remote resume run-tab dispatches to the launcher helper", async () => {
  runTabFromMap.mockResolvedValue(undefined);
  const exitCode = await main([
    "node",
    "remote",
    "resume",
    "run-tab",
    "--map",
    "/tmp/map.json",
    "--slot",
    "slot-1",
  ]);
  expect(exitCode).toBe(0);
  expect(runTabFromMap).toHaveBeenCalledWith("/tmp/map.json", "slot-1");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w @sentropic/remote-cli -- src/index.test.ts`

Expected: FAIL because `remote env` / `remote resume` commands and mocks are not wired.

- [ ] **Step 3: Wire Commander commands and add the user-facing doc**

```ts
// packages/remote-cli/src/index.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  editEnvironment,
  initEnvironment,
  listEnvironments,
  readEnvironment,
  validateEnvironment,
} from "./resume/environment.js";
import { discoverCandidates } from "./resume/discovery.js";
import { planLayout } from "./resume/layout.js";
import {
  buildGnomeTerminalArgs,
  runTabFromMap,
  writeLaunchArtifacts,
} from "./resume/launcher.js";

export {
  editEnvironment,
  initEnvironment,
  listEnvironments,
  readEnvironment,
  validateEnvironment,
} from "./resume/environment.js";

const envCommand = program.command("env").description("Manage remote resume environments");

envCommand
  .command("init [env]")
  .description("Materialize a managed environment config")
  .action((env = "dev") => {
    const materialized = initEnvironment(env);
    process.stdout.write(`${materialized.name}\n`);
  });

envCommand
  .command("list")
  .description("List available resume environments")
  .action(() => {
    for (const name of listEnvironments()) process.stdout.write(`${name}\n`);
  });

envCommand
  .command("show <env>")
  .description("Print the managed environment JSON")
  .action((env: string) => {
    process.stdout.write(`${JSON.stringify(readEnvironment(env), null, 2)}\n`);
  });

envCommand
  .command("validate <env>")
  .description("Validate the managed environment JSON")
  .action((env: string) => {
    const errors = validateEnvironment(readEnvironment(env));
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write("ok\n");
  });

envCommand
  .command("edit <env>")
  .description("Open the managed environment in $EDITOR")
  .action((env: string) => {
    const editor = process.env.EDITOR ?? "vi";
    const result = spawnSync(editor, [editEnvironment(env)], { stdio: "inherit" });
    if (result.status && result.status !== 0) {
      throw new Error(`${editor} exited with status ${result.status}`);
    }
  });

const resumeCommand = program.command("resume").description("Resume a managed development environment");

resumeCommand
  .argument("[env]", "environment name", "dev")
  .option("--dry-run", "plan sessions without launching terminals")
  .option("--status", "report candidate status without launching terminals")
  .option("--json", "emit JSON report (valid only with --dry-run or --status)")
  .option("--prefer <mode>", "local | remote | newest", "remote")
  .option("--project <project>", "filter to one canonical project")
  .option("--all", "ignore project defaults and include every discovered candidate")
  .action(async (env: string, opts: { dryRun?: boolean; status?: boolean; json?: boolean; prefer?: "local" | "remote" | "newest"; project?: string; all?: boolean }) => {
    if (opts.json && !opts.dryRun && !opts.status) {
      throw new Error("--json is only valid with --dry-run or --status");
    }

    const materialized = (() => {
      try {
        return readEnvironment(env);
      } catch (error) {
        if (env === "dev" && /ENOENT/.test(String(error))) return initEnvironment("dev");
        throw error;
      }
    })();
    const errors = validateEnvironment(materialized);
    if (errors.length > 0) throw new Error(errors.join("\n"));

    const candidates = await discoverCandidates({ env: materialized, prefer: opts.prefer });
    const filtered = opts.project
      ? candidates.filter((candidate) => candidate.project === opts.project)
      : candidates;
    const plan = planLayout(materialized, filtered, {
      ignoreProjectLimits: opts.all === true,
    });

    if (opts.dryRun || opts.status) {
      const report = { environment: materialized.name, plan };
      if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${plan.windows.length} window(s)\n`);
      return;
    }

    const launchRoot = mkdtempSync(join(tmpdir(), "remote-resume-"));
    const artifacts = writeLaunchArtifacts(plan, launchRoot);
    const args = buildGnomeTerminalArgs(plan, artifacts);
    const launched = spawnSync("gnome-terminal", args, { stdio: "inherit" });
    if (launched.status && launched.status !== 0) {
      throw new Error(`gnome-terminal exited with status ${launched.status}`);
    }
  });

resumeCommand
  .command("run-tab")
  .requiredOption("--map <path>", "launch map path")
  .requiredOption("--slot <slotId>", "slot id")
  .action(async (opts: { map: string; slot: string }) => {
    await runTabFromMap(opts.map, opts.slot);
  });
```

```md
<!-- docs/remote-resume.md -->
# remote resume

`remote resume` restores local and remote development-session layouts from a managed `remote env`.

## Commands

- `remote env init [env]`
- `remote env list`
- `remote env show <env>`
- `remote env edit <env>`
- `remote env validate <env>`
- `remote resume [env] --dry-run --json`
- `remote resume [env] --status --json`

## Notes

- `remote resume` auto-materializes `dev` on first use.
- `--json` is report-only and never launches terminals.
- Running local sessions are reported as `status-only` and are not duplicated.
- Legacy remote sessions without pairing metadata remain unpaired until selected explicitly.
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w @sentropic/remote-cli -- src/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the wider verification set**

Run: `npm run test -w @sentropic/remote-cli -- src/config.test.ts src/attach.test.ts src/migrate.test.ts src/index.test.ts src/resume/environment.test.ts src/resume/discovery.test.ts src/resume/layout.test.ts src/resume/launcher.test.ts`

Expected: PASS.

Run: `npm run test -w @sentropic/remote-control-plane -- src/index.test.ts`

Expected: PASS.

Run: `npm run typecheck -w @sentropic/remote-cli && npm run typecheck -w @sentropic/remote-control-plane && npm run typecheck -w @sentropic/remote-protocol`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  packages/remote-cli/src/index.ts \
  packages/remote-cli/src/index.test.ts \
  docs/remote-resume.md
git commit -m "feat(cli): add remote resume commands"
```

## Spec Coverage Check

- `remote env` owns layout config: covered by Task 1 and Task 7.
- Safe environment names and first-run `dev` bootstrap: covered by Task 1 and Task 7.
- Rich remote summaries with `workspaceId`, timestamps, metadata, and precise migrate-back targeting: covered by Task 2 and Task 3.
- Multi-session discovery, canonical project keys, and `status-only` local-running sessions: covered by Task 4.
- Deterministic group/shared-window planning and overflow ordering: covered by Task 5.
- Explicit slot binding, wrapper commands, and internal `run-tab`: covered by Task 6.
- JSON report-only semantics and user docs: covered by Task 7.

No spec gaps remain.
