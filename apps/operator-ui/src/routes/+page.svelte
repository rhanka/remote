<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    CLI_PROFILES,
    SESSION_TARGETS,
    type RemoteEventEnvelope,
    type SessionDescriptor,
  } from "@sentropic/remote-protocol";
  import {
    createSession,
    listSessions,
    persistApiBase,
    resolveApiBase,
    sendTerminalInput,
    sendTerminalResize,
    sessionEventStreamUrl,
    stopSession,
    listWorkspaces,
    createWorkspace,
    deleteWorkspace,
    type WorkspaceSummary,
  } from "../lib/api.js";
  import {
    ThemeProvider,
    AppHeader,
    Container,
    Grid,
    Flex,
    Stack,
    Card,
    Badge,
    Tag,
    Button,
    IconButton,
    Tooltip,
    Input,
    Select,
    Form,
    FormGroup,
    Alert,
    EmptyState,
    Typography,
    Divider,
  } from "@sentropic/design-system-svelte";

  let apiBase = $state("http://localhost:8080");
  let sessions = $state<SessionDescriptor[]>([]);
  let listError = $state<string | undefined>();
  let busy = $state(false);
  let selectedSessionId = $state<string | undefined>();

  let newProfile = $state<(typeof CLI_PROFILES)[number]>("codex");
  let newTarget = $state<(typeof SESSION_TARGETS)[number]>("k3s");
  let newDisplayName = $state("");

  let terminalContainer: HTMLDivElement | undefined = $state();
  let activeStream: EventSource | undefined;
  let terminal: import("@xterm/xterm").Terminal | undefined;
  let fitAddon: import("@xterm/addon-fit").FitAddon | undefined;
  let pendingDispose: Array<() => void> = [];

  $effect(() => {
    if (typeof window !== "undefined") persistApiBase(apiBase);
  });

  let workspaces = $state<WorkspaceSummary[]>([]);
  let workspaceError = $state<string | undefined>();
  let newWorkspaceName = $state("");

  async function refreshWorkspaces(): Promise<void> {
    try {
      workspaces = await listWorkspaces(apiBase);
      workspaceError = undefined;
    } catch (error) {
      workspaceError = error instanceof Error ? error.message : String(error);
    }
  }

  async function handleCreateWorkspace(): Promise<void> {
    busy = true;
    try {
      await createWorkspace(
        apiBase,
        newWorkspaceName ? { displayName: newWorkspaceName } : {},
      );
      newWorkspaceName = "";
      await refreshWorkspaces();
    } finally {
      busy = false;
    }
  }

  async function handleDeleteWorkspace(id: string): Promise<void> {
    if (!window.confirm(`Delete workspace ${id} and its retained volume?`))
      return;
    busy = true;
    try {
      await deleteWorkspace(apiBase, id);
      await refreshWorkspaces();
    } finally {
      busy = false;
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      sessions = await listSessions(apiBase);
      listError = undefined;
    } catch (error) {
      listError = String(error);
    }
  }

  async function handleCreate(): Promise<void> {
    busy = true;
    try {
      const body: { profile: string; target: string; displayName?: string } = {
        profile: newProfile,
        target: newTarget,
      };
      if (newDisplayName.trim()) body.displayName = newDisplayName.trim();
      const session = await createSession(apiBase, body);
      await refreshSessions();
      await openSession(session.id);
      newDisplayName = "";
    } catch (error) {
      listError = String(error);
    } finally {
      busy = false;
    }
  }

  async function handleStop(id: string): Promise<void> {
    busy = true;
    try {
      await stopSession(apiBase, id, "operator-ui");
      if (selectedSessionId === id) closeTerminal();
      await refreshSessions();
    } catch (error) {
      listError = String(error);
    } finally {
      busy = false;
    }
  }

  async function openSession(id: string): Promise<void> {
    if (selectedSessionId === id && terminal) return;
    closeTerminal();
    selectedSessionId = id;
    await tick();
    if (!terminalContainer) return;

    const xterm = await import("@xterm/xterm");
    const fit = await import("@xterm/addon-fit").catch(() => null);
    terminal = new xterm.Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      theme: { background: "#0e151c", foreground: "#d7e1ea" },
    });
    if (fit && (fit as { FitAddon: typeof import("@xterm/addon-fit").FitAddon }).FitAddon) {
      fitAddon = new fit.FitAddon();
      terminal.loadAddon(fitAddon);
    }
    terminal.open(terminalContainer);
    fitAddon?.fit();

    const onResize = () => {
      try {
        fitAddon?.fit();
        if (terminal) {
          void sendTerminalResize(apiBase, id, terminal.cols, terminal.rows);
        }
      } catch {
        // ignore measurement errors
      }
    };
    window.addEventListener("resize", onResize);
    pendingDispose.push(() => window.removeEventListener("resize", onResize));

    const subscription = terminal.onData((data: string) => {
      void sendTerminalInput(apiBase, id, data);
    });
    pendingDispose.push(() => subscription.dispose());

    const source = new EventSource(sessionEventStreamUrl(apiBase, id));
    activeStream = source;
    pendingDispose.push(() => source.close());

    const handleEnvelope = (raw: string) => {
      try {
        const envelope = JSON.parse(raw) as RemoteEventEnvelope;
        if (envelope.type === "terminal.output") {
          const payload = envelope.payload as { data?: string };
          if (typeof payload.data === "string") terminal?.write(payload.data);
        } else if (envelope.type === "terminal.exited") {
          terminal?.writeln("\r\n[remote] session exited");
        }
      } catch {
        // ignore malformed
      }
    };
    source.addEventListener("terminal.output", (event) =>
      handleEnvelope((event as MessageEvent).data),
    );
    source.addEventListener("terminal.exited", (event) =>
      handleEnvelope((event as MessageEvent).data),
    );
    source.onmessage = (event) => handleEnvelope(event.data);
  }

  function closeTerminal(): void {
    for (const dispose of pendingDispose) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    pendingDispose = [];
    terminal?.dispose();
    terminal = undefined;
    fitAddon = undefined;
    activeStream = undefined;
    selectedSessionId = undefined;
  }

  function statusLabel(session: SessionDescriptor): string {
    return session.displayName ?? session.profile;
  }

  onMount(() => {
    apiBase = resolveApiBase();
    void refreshSessions();
    void refreshWorkspaces();
    const interval = window.setInterval(() => {
      void refreshSessions();
      void refreshWorkspaces();
    }, 5000);
    return () => window.clearInterval(interval);
  });

  onDestroy(() => closeTerminal());
</script>

<svelte:head>
  <title>sentropic remote — operator</title>
</svelte:head>

<ThemeProvider>
  <div class="shell">
    <AppHeader>
      {#snippet logo()}
        <Flex direction="column" gap={0}>
          <Typography variant="h5" as="span" weight="semibold">sentropic remote</Typography>
          <Typography variant="caption" tone="secondary" as="span">
            operator console — list, create, attach
          </Typography>
        </Flex>
      {/snippet}
      {#snippet actions()}
        <div class="api-field">
          <Input
            type="url"
            label="control-plane"
            size="sm"
            spellcheck="false"
            bind:value={apiBase}
          />
        </div>
      {/snippet}
    </AppHeader>

    <Grid class="layout" columns={1} gap={0}>
      <Container as="nav" size="full" padding aria-label="Sessions" class="sidebar">
        <Stack gap={4}>
          <Stack gap={3}>
            <Typography variant="h6" as="h2">Sessions</Typography>

            {#if listError}
              <Alert tone="error" title="Sessions error" message={listError} />
            {/if}

            {#if sessions.length === 0}
              <EmptyState title="no session yet" message="Create one below to attach a terminal." />
            {:else}
              {#each sessions as session (session.id)}
                <Card interactive class={selectedSessionId === session.id ? "row row--active" : "row"}>
                  <Flex justify="between" align="start" gap={2}>
                    <button
                      type="button"
                      class="row__open"
                      onclick={() => openSession(session.id)}
                    >
                      <Typography variant="body-sm" as="span" weight="semibold">
                        {statusLabel(session)}
                      </Typography>
                      <Flex gap={1} wrap align="center" class="row__meta">
                        <Badge tone="info">{session.profile}</Badge>
                        <Badge tone="neutral">{session.target}</Badge>
                        <Typography variant="caption" tone="muted" as="span">{session.id}</Typography>
                      </Flex>
                    </button>
                    <Tooltip content="Stop session">
                      <IconButton
                        aria-label={`Stop session ${session.id}`}
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onclick={() => handleStop(session.id)}
                      >
                        ✕
                      </IconButton>
                    </Tooltip>
                  </Flex>
                </Card>
              {/each}
            {/if}

            <Card class="form-card">
              <Form onsubmit={() => handleCreate()} submitting={busy}>
                <FormGroup legend="New session">
                  <Stack gap={3}>
                    <Select label="profile" bind:value={newProfile}>
                      {#each CLI_PROFILES as profile}
                        <option value={profile}>{profile}</option>
                      {/each}
                    </Select>
                    <Select label="target" bind:value={newTarget}>
                      {#each SESSION_TARGETS as target}
                        <option value={target}>{target}</option>
                      {/each}
                    </Select>
                    <Input label="display name" placeholder="optional" bind:value={newDisplayName} />
                    <Button type="submit" variant="primary" disabled={busy}>
                      {busy ? "..." : "Create + attach"}
                    </Button>
                  </Stack>
                </FormGroup>
              </Form>
            </Card>
          </Stack>

          <Divider />

          <Stack gap={3}>
            <Typography variant="h6" as="h2">Workspaces</Typography>

            {#if workspaceError}
              <Alert tone="error" title="Workspaces error" message={workspaceError} />
            {/if}

            {#if workspaces.length === 0}
              <EmptyState title="no workspace" message="Create one below." />
            {:else}
              {#each workspaces as ws (ws.id)}
                <Card class="row">
                  <Flex justify="between" align="start" gap={2}>
                    <Stack gap={1}>
                      <Typography variant="body-sm" as="span" weight="semibold">
                        {ws.displayName ?? ws.id}
                      </Typography>
                      <Typography variant="caption" tone="muted" as="span">{ws.id}</Typography>
                      {#if ws.lock}
                        <Tooltip content={`held since ${ws.lock.acquiredAt}`}>
                          <Tag tone="warning" size="sm">🔒 {ws.lock.holder}</Tag>
                        </Tooltip>
                      {/if}
                    </Stack>
                    <Tooltip content="Delete workspace">
                      <IconButton
                        aria-label={`Delete workspace ${ws.id}`}
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onclick={() => handleDeleteWorkspace(ws.id)}
                      >
                        ✕
                      </IconButton>
                    </Tooltip>
                  </Flex>
                </Card>
              {/each}
            {/if}

            <Card class="form-card">
              <Form onsubmit={() => handleCreateWorkspace()} submitting={busy}>
                <FormGroup legend="New workspace">
                  <Stack gap={3}>
                    <Input label="new workspace" placeholder="name (optional)" bind:value={newWorkspaceName} />
                    <Button type="submit" variant="primary" disabled={busy}>
                      {busy ? "..." : "Create workspace"}
                    </Button>
                  </Stack>
                </FormGroup>
              </Form>
            </Card>
          </Stack>
        </Stack>
      </Container>

      <Container as="section" size="full" aria-label="Terminal" class="terminal-pane">
        {#if selectedSessionId}
          <Flex justify="between" align="center" class="terminal-bar">
            <Typography variant="caption" as="span" tone="inverse">{selectedSessionId}</Typography>
            <Button variant="ghost" size="sm" onclick={closeTerminal}>close</Button>
          </Flex>
          <!--
            NEGOTIATED GAP: the xterm.js terminal emulator is a live canvas, not a
            DS component. It mounts into this container via bind:this. No DS
            equivalent exists; framed in DS Container + Flex header + tokens.
          -->
          <div class="xterm" bind:this={terminalContainer}></div>
        {:else}
          <div class="terminal-empty">
            <EmptyState
              title="No session attached"
              message="Pick a session on the left, or create one."
            />
          </div>
        {/if}
      </Container>
    </Grid>
  </div>
</ThemeProvider>

<style>
  /* Layout glue only — all colors/spacing via DS tokens, no hardcoded hex. */
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: var(--st-semantic-surface-subtle);
    color: var(--st-semantic-text-primary);
  }

  .shell {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100vh;
  }

  .api-field {
    width: 20rem;
    max-width: 100%;
  }

  /* DS Grid renders a CSS grid; override its single column to sidebar + main. */
  :global(.layout) {
    grid-template-columns: 22rem 1fr;
    align-items: stretch;
    min-height: 0;
  }

  :global(.sidebar) {
    border-right: 1px solid var(--st-semantic-border-subtle);
    overflow-y: auto;
  }

  :global(.row__active),
  :global(.row--active) {
    box-shadow: 0 0 0 2px var(--st-semantic-border-interactive);
  }

  .row__open {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--st-spacing-2, 0.5rem);
    background: transparent;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }

  :global(.terminal-pane) {
    display: grid;
    grid-template-rows: auto 1fr;
    min-width: 0;
    background: var(--st-semantic-surface-inverse);
    color: var(--st-semantic-text-inverse);
  }

  :global(.terminal-bar) {
    padding: var(--st-spacing-3, 0.75rem) var(--st-spacing-4, 1rem);
    border-bottom: 1px solid var(--st-semantic-border-strong);
  }

  .xterm {
    height: 100%;
    width: 100%;
    min-height: 0;
  }

  .terminal-empty {
    display: grid;
    place-items: center;
    height: 100%;
  }
</style>
