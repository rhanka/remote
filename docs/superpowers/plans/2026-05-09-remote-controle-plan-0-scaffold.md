# remote-controle Plan 0 Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the initial monorepo scaffold for the Kubernetes-native `remote-controle` MVP with TypeScript backend packages, a Svelte 5 frontend, and `@sent-tech/components-svelte`.

**Architecture:** This plan creates only the repository structure and compileable package skeleton. Runtime behavior is limited to typed domain models, a backend health endpoint, and a frontend shell; Kubernetes orchestration, PTY, approvals, browser bridge, and E2E flows are handled by later plans.

**Tech Stack:** pnpm workspaces, TypeScript, Vitest, tsup, Fastify, Svelte 5, SvelteKit, Vite, `@sent-tech/components-svelte@0.1.0`, `voxtral-transcribe-ts@0.1.3`.

---

## Scope Check

The validated spec covers multiple subsystems, so implementation is split into multiple plans:

- Plan 0: monorepo scaffold, package boundaries, baseline checks.
- Plan 1: protocol and typed session/capability/event model.
- Plan 2: Kubernetes orchestrator for k3s.
- Plan 3: `session-agent` and terminal PTY transport.
- Plan 4: approvals, secrets, and 2FA flow.
- Plan 5: Svelte 5 operator frontend.
- Plan 6: browser/UAT bridge.
- Plan 7: k3s end-to-end MVP.
- Plan V2: TypeScript micro-OS research and feasibility gates.

This document implements Plan 0 only.

## File Structure

Create these files:

- `package.json`: root workspace scripts and dev dependencies.
- `pnpm-workspace.yaml`: workspace globs.
- `tsconfig.base.json`: shared strict TypeScript config.
- `.gitignore`: Node, build, local env, SvelteKit, coverage.
- `.npmrc`: pnpm package manager defaults.
- `apps/control-plane/package.json`: backend app package.
- `apps/control-plane/tsconfig.json`: backend TypeScript config.
- `apps/control-plane/src/index.ts`: Fastify app factory and startup.
- `apps/control-plane/src/index.test.ts`: backend health route test.
- `apps/operator-ui/package.json`: Svelte 5 frontend package.
- `apps/operator-ui/tsconfig.json`: SvelteKit TypeScript config.
- `apps/operator-ui/vite.config.ts`: SvelteKit/Vitest config.
- `apps/operator-ui/svelte.config.js`: SvelteKit config.
- `apps/operator-ui/src/app.html`: Svelte app template.
- `apps/operator-ui/src/routes/+page.svelte`: operator shell using `@sent-tech/components-svelte` as the preferred design system dependency.
- `packages/protocol/package.json`: shared protocol package.
- `packages/protocol/tsconfig.json`: protocol TypeScript config.
- `packages/protocol/src/index.ts`: exported MVP constants and type surface.
- `packages/protocol/src/index.test.ts`: protocol type/value tests.
- `packages/k8s-orchestrator/package.json`: future Kubernetes orchestration package skeleton.
- `packages/k8s-orchestrator/tsconfig.json`: package TS config.
- `packages/k8s-orchestrator/src/index.ts`: exported package metadata for the future orchestration boundary.
- `packages/session-agent/package.json`: future session-agent package skeleton.
- `packages/session-agent/tsconfig.json`: package TS config.
- `packages/session-agent/src/index.ts`: exported package metadata.
- `packages/approval-core/package.json`: future approvals package skeleton.
- `packages/approval-core/tsconfig.json`: package TS config.
- `packages/approval-core/src/index.ts`: exported package metadata.
- `packages/secret-broker/package.json`: future secret broker package skeleton.
- `packages/secret-broker/tsconfig.json`: package TS config.
- `packages/secret-broker/src/index.ts`: exported package metadata.
- `packages/terminal-transport/package.json`: future terminal transport package skeleton.
- `packages/terminal-transport/tsconfig.json`: package TS config.
- `packages/terminal-transport/src/index.ts`: exported package metadata.
- `packages/browser-bridge/package.json`: future browser bridge package skeleton.
- `packages/browser-bridge/tsconfig.json`: package TS config.
- `packages/browser-bridge/src/index.ts`: exported package metadata.

The package names use the temporary scaffold scope `@sentropic/remote-*`. The validated publishing family is `@sentropic/remote-*`; rename package manifests after npm scope access is confirmed.

## Task 1: Root Workspace

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.npmrc`

- [ ] **Step 1: Create the root `package.json`**

Write `package.json`:

```json
{
  "name": "remote-controle",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.0.9",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=11.0.0"
  },
  "scripts": {
    "build": "corepack pnpm -r --if-present build",
    "dev": "corepack pnpm --filter @sentropic/remote-control-plane dev",
    "dev:ui": "corepack pnpm --filter @sentropic/remote-operator-ui dev",
    "format": "prettier --check .",
    "format:write": "prettier --write .",
    "lint": "corepack pnpm -r --if-present lint",
    "test": "corepack pnpm -r --if-present test",
    "typecheck": "corepack pnpm -r --if-present typecheck",
    "verify": "corepack pnpm format && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build"
  },
  "devDependencies": {
    "@types/node": "^22.19.18",
    "prettier": "^3.8.3",
    "typescript": "^6.0.3",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 2: Create the pnpm workspace file**

Write `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
allowBuilds:
  esbuild: true
  onnxruntime-node: true
  protobufjs: true
  sharp: true
```

- [ ] **Step 3: Create the shared TypeScript config**

Write `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "ignoreDeprecations": "6.0",
    "isolatedModules": true
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

Write `.gitignore`:

```gitignore
node_modules/
.pnpm-store/
dist/
build/
.svelte-kit/
.vite/
coverage/
.env
.env.*
!.env.example
*.log
.DS_Store
.superpowers/
```

- [ ] **Step 5: Create `.npmrc`**

Write `.npmrc`:

```ini
engine-strict=true
strict-peer-dependencies=false
auto-install-peers=true
```

- [ ] **Step 6: Commit root workspace files**

Run:

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .npmrc
git commit -m "chore: scaffold root workspace"
```

Expected:

- Commit succeeds.
- `git status --short` does not list these five files.

## Task 2: Protocol Package

**Files:**

- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/index.test.ts`

- [ ] **Step 1: Create `packages/protocol/package.json`**

```json
{
  "name": "@sentropic/remote-protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "lint": "tsc --noEmit",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "tsup": "^8.5.1"
  }
}
```

- [ ] **Step 2: Create `packages/protocol/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the initial protocol types**

Write `packages/protocol/src/index.ts`:

```ts
export const REMOTE_CONTROLE_PROTOCOL_VERSION = "0.0.0";

export const CLI_PROFILES = [
  "shell",
  "codex",
  "opencode",
  "claude-code",
  "gemini-cli",
] as const;

export type CliProfile = (typeof CLI_PROFILES)[number];

export const CAPABILITIES = [
  "read-secret",
  "push-git",
  "publish-npm",
  "create-cloud-resource",
  "install-system-package",
  "browser-login",
  "browser-sensitive-action",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type SessionTarget = "k3s" | "scaleway-kapsule" | "gke";

export interface SessionDescriptor {
  readonly id: string;
  readonly profile: CliProfile;
  readonly target: SessionTarget;
  readonly workspacePath: "/workspace";
}
```

- [ ] **Step 4: Create protocol tests**

Write `packages/protocol/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CLI_PROFILES,
  REMOTE_CONTROLE_PROTOCOL_VERSION,
  type SessionDescriptor,
} from "./index.js";

describe("protocol constants", () => {
  it("declares the MVP CLI profiles", () => {
    expect(CLI_PROFILES).toEqual([
      "shell",
      "codex",
      "opencode",
      "claude-code",
      "gemini-cli",
    ]);
  });

  it("declares capability-based approval names", () => {
    expect(CAPABILITIES).toContain("read-secret");
    expect(CAPABILITIES).toContain("browser-sensitive-action");
  });

  it("uses an explicit protocol version", () => {
    expect(REMOTE_CONTROLE_PROTOCOL_VERSION).toBe("0.0.0");
  });

  it("models a k3s session workspace", () => {
    const descriptor: SessionDescriptor = {
      id: "session-001",
      profile: "codex",
      target: "k3s",
      workspacePath: "/workspace",
    };

    expect(descriptor.workspacePath).toBe("/workspace");
  });
});
```

- [ ] **Step 5: Run protocol tests**

Run:

```bash
pnpm --filter @sentropic/remote-protocol test
```

Expected:

- Vitest exits with status 0.
- Output includes 4 passing tests.

- [ ] **Step 6: Commit protocol package**

Run:

```bash
git add packages/protocol
git commit -m "feat: add protocol package scaffold"
```

Expected:

- Commit succeeds.

## Task 3: Backend Control Plane Skeleton

**Files:**

- Create: `apps/control-plane/package.json`
- Create: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/src/index.ts`
- Create: `apps/control-plane/src/index.test.ts`

- [ ] **Step 1: Create `apps/control-plane/package.json`**

```json
{
  "name": "@sentropic/remote-control-plane",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "dev": "tsx watch src/index.ts",
    "lint": "tsc --noEmit",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/websocket": "^11.2.0",
    "@kubernetes/client-node": "^1.4.0",
    "@sentropic/remote-protocol": "workspace:*",
    "fastify": "^5.8.5",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "tsup": "^8.5.1",
    "tsx": "^4.21.0"
  }
}
```

- [ ] **Step 2: Create `apps/control-plane/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the Fastify app factory**

Write `apps/control-plane/src/index.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { REMOTE_CONTROLE_PROTOCOL_VERSION } from "@sentropic/remote-protocol";

export function createControlPlane(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({
    ok: true,
    service: "sentropic-remote-control-plane",
    protocolVersion: REMOTE_CONTROLE_PROTOCOL_VERSION,
  }));

  return app;
}

export async function startControlPlane(): Promise<void> {
  const app = createControlPlane();
  const port = Number(process.env.PORT ?? "8080");
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ host, port });
}

if (process.env.NODE_ENV !== "test") {
  await startControlPlane();
}
```

- [ ] **Step 4: Create backend tests**

Write `apps/control-plane/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createControlPlane } from "./index.js";

describe("control plane", () => {
  it("serves a health endpoint with the protocol version", async () => {
    const app = createControlPlane();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "sentropic-remote-control-plane",
      protocolVersion: "0.0.0",
    });

    await app.close();
  });
});
```

- [ ] **Step 5: Run backend tests**

Run:

```bash
pnpm --filter @sentropic/remote-control-plane test
```

Expected:

- Vitest exits with status 0.
- Output includes 1 passing test.

- [ ] **Step 6: Commit backend scaffold**

Run:

```bash
git add apps/control-plane
git commit -m "feat: add control plane scaffold"
```

Expected:

- Commit succeeds.

## Task 4: Placeholder-Free Core Package Boundaries

**Files:**

- Create: `packages/k8s-orchestrator/package.json`
- Create: `packages/k8s-orchestrator/tsconfig.json`
- Create: `packages/k8s-orchestrator/src/index.ts`
- Create: `packages/session-agent/package.json`
- Create: `packages/session-agent/tsconfig.json`
- Create: `packages/session-agent/src/index.ts`
- Create: `packages/approval-core/package.json`
- Create: `packages/approval-core/tsconfig.json`
- Create: `packages/approval-core/src/index.ts`
- Create: `packages/secret-broker/package.json`
- Create: `packages/secret-broker/tsconfig.json`
- Create: `packages/secret-broker/src/index.ts`
- Create: `packages/terminal-transport/package.json`
- Create: `packages/terminal-transport/tsconfig.json`
- Create: `packages/terminal-transport/src/index.ts`
- Create: `packages/browser-bridge/package.json`
- Create: `packages/browser-bridge/tsconfig.json`
- Create: `packages/browser-bridge/src/index.ts`

- [ ] **Step 1: Create package files for each boundary**

For each package name below:

- `k8s-orchestrator`
- `session-agent`
- `approval-core`
- `secret-broker`
- `terminal-transport`
- `browser-bridge`

Write `packages/<name>/package.json`, replacing `<name>` with the package directory:

```json
{
  "name": "@sentropic/remote-<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "lint": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sentropic/remote-protocol": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.5.1"
  }
}
```

The literal `<name>` must not remain in any written file. Example for `packages/k8s-orchestrator/package.json`:

```json
{
  "name": "@sentropic/remote-k8s-orchestrator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "lint": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sentropic/remote-protocol": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.4.0"
  }
}
```

- [ ] **Step 2: Create package TypeScript configs**

For each package directory from Step 1, write `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create explicit package metadata exports**

For each package directory from Step 1, write `src/index.ts` with the exact package name.

Example for `packages/k8s-orchestrator/src/index.ts`:

```ts
export const packageName = "@sentropic/remote-k8s-orchestrator";
```

Use these exact contents:

```ts
// packages/session-agent/src/index.ts
export const packageName = "@sentropic/remote-session-agent";
```

```ts
// packages/approval-core/src/index.ts
export const packageName = "@sentropic/remote-approval-core";
```

```ts
// packages/secret-broker/src/index.ts
export const packageName = "@sentropic/remote-secret-broker";
```

```ts
// packages/terminal-transport/src/index.ts
export const packageName = "@sentropic/remote-terminal-transport";
```

```ts
// packages/browser-bridge/src/index.ts
export const packageName = "@sentropic/remote-browser-bridge";
```

- [ ] **Step 4: Verify no template marker remains**

Run:

```bash
rg "<name>" packages
```

Expected:

- Command exits with status 1 because no matches are found.

- [ ] **Step 5: Commit package boundaries**

Run:

```bash
git add packages/k8s-orchestrator packages/session-agent packages/approval-core packages/secret-broker packages/terminal-transport packages/browser-bridge
git commit -m "chore: add core package boundaries"
```

Expected:

- Commit succeeds.

## Task 5: Svelte 5 Operator UI Skeleton

**Files:**

- Create: `apps/operator-ui/package.json`
- Create: `apps/operator-ui/tsconfig.json`
- Create: `apps/operator-ui/vite.config.ts`
- Create: `apps/operator-ui/svelte.config.js`
- Create: `apps/operator-ui/src/app.html`
- Create: `apps/operator-ui/src/routes/+page.svelte`

- [ ] **Step 1: Create `apps/operator-ui/package.json`**

`@sent-tech/components-svelte@0.1.0` was verified with `npm view @sent-tech/components-svelte version`.
`voxtral-transcribe-ts@0.1.3` was verified with `npm search voxtral --json` and is the published Voxtral TypeScript package from the `rhk` npm publisher.
The native build-script allowlist is limited to `esbuild` plus `voxtral-transcribe-ts` transitive native dependencies: `onnxruntime-node`, `protobufjs`, `sharp`.

```json
{
  "name": "@sentropic/remote-operator-ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite dev --host 0.0.0.0",
    "lint": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "typecheck": "svelte-check --tsconfig ./tsconfig.json"
  },
  "dependencies": {
    "@sentropic/remote-protocol": "workspace:*",
    "@sent-tech/components-svelte": "0.1.0",
    "@sveltejs/adapter-node": "^5.5.4",
    "@sveltejs/kit": "^2.59.1",
    "@sveltejs/vite-plugin-svelte": "^7.1.2",
    "@xterm/xterm": "^6.0.0",
    "svelte": "^5.55.5",
    "vite": "^8.0.11",
    "voxtral-transcribe-ts": "0.1.3"
  },
  "devDependencies": {
    "jsdom": "^29.1.1",
    "svelte-check": "^4.4.8"
  }
}
```

- [ ] **Step 2: Create `apps/operator-ui/svelte.config.js`**

```js
import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
};

export default config;
```

- [ ] **Step 3: Create `apps/operator-ui/vite.config.ts`**

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: "jsdom",
  },
});
```

- [ ] **Step 4: Create `apps/operator-ui/tsconfig.json`**

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

- [ ] **Step 5: Create `apps/operator-ui/src/app.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
```

- [ ] **Step 6: Create the initial Svelte 5 route**

Write `apps/operator-ui/src/routes/+page.svelte`:

```svelte
<script lang="ts">
  import { CLI_PROFILES } from "@sentropic/remote-protocol";

  const sessions = [
    { id: "session-001", label: "Codex k3s", status: "ready", profile: "codex" },
    { id: "session-002", label: "Browser UAT", status: "waiting approval", profile: "shell" }
  ] as const;
</script>

<svelte:head>
  <title>remote-controle</title>
</svelte:head>

<main class="shell">
  <header class="topbar">
    <div>
      <h1>remote-controle</h1>
      <p>Kubernetes-native CLI session control</p>
    </div>
    <button type="button">New session</button>
  </header>

  <section class="layout" aria-label="Operator workspace">
    <nav class="sessions" aria-label="Sessions">
      {#each sessions as session}
        <button type="button" class:attention={session.status !== "ready"}>
          <strong>{session.label}</strong>
          <span>{session.status}</span>
        </button>
      {/each}
    </nav>

    <section class="terminal" aria-label="Terminal">
      <div class="terminal-bar">
        <span>session-001</span>
        <span>{CLI_PROFILES.join(" / ")}</span>
      </div>
      <pre>$ codex exec \"run tests and open UAT\"</pre>
    </section>

    <aside class="events" aria-label="Approvals and events">
      <h2>Approvals</h2>
      <p>No pending capability request.</p>
    </aside>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
    color: #172026;
    background: #f6f7f8;
  }

  .shell {
    min-height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr;
  }

  .topbar {
    min-height: 72px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 20px;
    border-bottom: 1px solid #d9dee3;
    background: #ffffff;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 20px;
    line-height: 1.2;
  }

  .topbar p {
    margin-top: 4px;
    color: #5a6672;
    font-size: 13px;
  }

  button {
    min-height: 36px;
    border: 1px solid #b8c2cc;
    border-radius: 6px;
    background: #ffffff;
    color: #172026;
    font: inherit;
    cursor: pointer;
  }

  .layout {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr) 300px;
    min-height: 0;
  }

  .sessions {
    display: grid;
    align-content: start;
    gap: 8px;
    padding: 12px;
    border-right: 1px solid #d9dee3;
    background: #ffffff;
  }

  .sessions button {
    display: grid;
    gap: 4px;
    justify-items: start;
    padding: 10px;
    text-align: left;
  }

  .sessions span {
    color: #5a6672;
    font-size: 12px;
  }

  .sessions .attention {
    border-color: #8a6f00;
    background: #fff9db;
  }

  .terminal {
    min-width: 0;
    display: grid;
    grid-template-rows: auto 1fr;
    background: #111820;
    color: #d7e1ea;
  }

  .terminal-bar {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid #2c3946;
    color: #9fb0bf;
    font-size: 12px;
  }

  pre {
    margin: 0;
    padding: 16px;
    overflow: auto;
    font-size: 14px;
    line-height: 1.5;
  }

  .events {
    padding: 16px;
    border-left: 1px solid #d9dee3;
    background: #ffffff;
  }

  .events h2 {
    margin-bottom: 8px;
    font-size: 16px;
  }

  .events p {
    color: #5a6672;
    font-size: 13px;
  }

  @media (max-width: 900px) {
    .layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(320px, 1fr) auto;
    }

    .sessions {
      grid-auto-flow: column;
      grid-auto-columns: minmax(180px, 1fr);
      overflow-x: auto;
      border-right: 0;
      border-bottom: 1px solid #d9dee3;
      scroll-snap-type: x mandatory;
    }

    .sessions button {
      scroll-snap-align: start;
    }

    .events {
      border-left: 0;
      border-top: 1px solid #d9dee3;
    }
  }
```

This route intentionally uses native elements for the first scaffold while the dependency on `@sent-tech/components-svelte` is installed. Plan 5 replaces the native controls with concrete `@sent-tech` components after checking the package exports.

- [ ] **Step 7: Commit operator UI scaffold**

Run:

```bash
git add apps/operator-ui
git commit -m "feat: add operator ui scaffold"
```

Expected:

- Commit succeeds.

## Task 6: Install And Verify

**Files:**

- Modify: `pnpm-lock.yaml`
- Create: `.prettierignore`

- [ ] **Step 1: Install dependencies**

Run:

```bash
corepack enable pnpm
corepack pnpm install
```

Expected:

- `pnpm-lock.yaml` is created.
- Install exits with status 0.

- [ ] **Step 2: Verify formatting**

Run:

```bash
corepack pnpm format
```

Expected:

- Prettier exits with status 0.
- `.prettierignore` preserves raw brief audit files at `docs/brief-as-is.md` and `docs/brief-additions/*.md` as-is.

- [ ] **Step 3: Verify typechecking**

Run:

```bash
corepack pnpm typecheck
```

Expected:

- TypeScript and `svelte-check` exit with status 0.

- [ ] **Step 4: Verify tests**

Run:

```bash
corepack pnpm test
```

Expected:

- Protocol tests pass.
- Control-plane tests pass.

- [ ] **Step 5: Verify build**

Run:

```bash
corepack pnpm build
```

Expected:

- All packages with build scripts produce `dist` or SvelteKit build output.
- Command exits with status 0.

- [ ] **Step 6: Run full verification**

Run:

```bash
corepack pnpm verify
```

Expected:

- Formatting, lint, typecheck, tests, and build all exit with status 0.

- [ ] **Step 7: Commit lockfile and verification scaffold**

Run:

```bash
git add pnpm-lock.yaml
git commit -m "chore: add workspace lockfile"
```

Expected:

- Commit succeeds.

## Task 7: Documentation Update

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Replace the README with scaffold instructions**

Write `README.md`:

````md
# remote-controle

Kubernetes-native orchestration for delegated CLI sessions.

## Stack

- Backend: TypeScript control plane.
- Frontend: Svelte 5 operator UI.
- UI design system: `@sent-tech/components-svelte`.
- Workspace: pnpm monorepo.
- First runtime target: k3s, then Scaleway Kapsule, then GKE.

## Docs

- Initial brief: `docs/brief-as-is.md`
- Traceability: `docs/traceability/2026-05-09-intention-spec-decisions.md`
- MVP spec: `docs/superpowers/specs/2026-05-09-remote-controle-mvp-design.md`
- Plan 0 scaffold: `docs/superpowers/plans/2026-05-09-remote-controle-plan-0-scaffold.md`

## Commands

```bash
corepack enable pnpm
corepack pnpm install
corepack pnpm verify
```
````

- [ ] **Step 2: Commit README update**

Run:

```bash
git add README.md
git commit -m "docs: describe scaffold workspace"
```

Expected:

- Commit succeeds.

## Self-Review

- Spec coverage:
  - TypeScript backend is covered by `apps/control-plane`.
  - Svelte 5 frontend is covered by `apps/operator-ui`.
  - `@sent-tech/components-svelte` is pinned as an installed frontend dependency.
  - Publishable package structure is covered by `packages/*` and workspaces.
  - Kubernetes-native implementation is not implemented in Plan 0 and is explicitly deferred to Plan 2.
- Red-flag scan:
  - Generated files must not contain unresolved work markers or vague implementation steps.
  - The literal marker `<name>` is checked with `rg "<name>" packages`.
- Type consistency:
  - Package scope is consistently `@sentropic/remote-*`.
  - Protocol exports use `CliProfile`, `Capability`, and `SessionDescriptor`.
  - Backend imports `REMOTE_CONTROLE_PROTOCOL_VERSION` from `@sentropic/remote-protocol`.
- pnpm build scripts:
  - pnpm 11 allows only `esbuild` build scripts because Vite, Vitest, and tsup depend on it.
