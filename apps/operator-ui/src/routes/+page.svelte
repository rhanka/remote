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
  } from "../lib/api.js";

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
    const interval = window.setInterval(refreshSessions, 5000);
    return () => window.clearInterval(interval);
  });

  onDestroy(() => closeTerminal());
</script>

<svelte:head>
  <title>sentropic remote — operator</title>
</svelte:head>

<main class="shell">
  <header class="topbar">
    <div>
      <h1>sentropic remote</h1>
      <p>operator console — list, create, attach</p>
    </div>
    <label class="api">
      <span>control-plane</span>
      <input type="url" bind:value={apiBase} spellcheck="false" />
    </label>
  </header>

  <section class="layout">
    <nav class="sessions" aria-label="Sessions">
      <h2>Sessions</h2>
      {#if listError}
        <p class="error">{listError}</p>
      {/if}
      {#if sessions.length === 0}
        <p class="muted">no session yet</p>
      {/if}
      {#each sessions as session (session.id)}
        <article class:active={selectedSessionId === session.id}>
          <button type="button" onclick={() => openSession(session.id)}>
            <strong>{statusLabel(session)}</strong>
            <span class="meta">
              {session.profile} · {session.target} · {session.id}
            </span>
          </button>
          <button
            type="button"
            class="stop"
            onclick={() => handleStop(session.id)}
            disabled={busy}
            title="Stop session"
          >
            ✕
          </button>
        </article>
      {/each}

      <form class="create" onsubmit={(event) => { event.preventDefault(); void handleCreate(); }}>
        <h3>New session</h3>
        <label>
          profile
          <select bind:value={newProfile}>
            {#each CLI_PROFILES as profile}
              <option value={profile}>{profile}</option>
            {/each}
          </select>
        </label>
        <label>
          target
          <select bind:value={newTarget}>
            {#each SESSION_TARGETS as target}
              <option value={target}>{target}</option>
            {/each}
          </select>
        </label>
        <label>
          display name
          <input
            type="text"
            placeholder="optional"
            bind:value={newDisplayName}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "..." : "Create + attach"}
        </button>
      </form>
    </nav>

    <section class="terminal" aria-label="Terminal">
      {#if selectedSessionId}
        <div class="terminal-bar">
          <span>{selectedSessionId}</span>
          <button type="button" onclick={closeTerminal}>close</button>
        </div>
        <div class="xterm" bind:this={terminalContainer}></div>
      {:else}
        <div class="placeholder">
          <p>pick a session on the left, or create one.</p>
        </div>
      {/if}
    </section>
  </section>
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #f4f6f8;
    color: #1a232c;
    font-family:
      -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
      sans-serif;
  }

  .shell {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100vh;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 24px;
    border-bottom: 1px solid #d9dee3;
    background: #ffffff;
  }

  .topbar h1 {
    margin: 0;
    font-size: 18px;
  }

  .topbar p {
    margin: 0;
    color: #5a6672;
    font-size: 13px;
  }

  .api {
    display: flex;
    flex-direction: column;
    font-size: 12px;
    gap: 4px;
  }
  .api input {
    width: 320px;
    padding: 6px 8px;
    border: 1px solid #c5ccd2;
    border-radius: 4px;
    font: inherit;
  }

  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    min-height: 0;
  }

  .sessions {
    border-right: 1px solid #d9dee3;
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .sessions h2,
  .sessions h3 {
    margin: 0;
    font-size: 14px;
  }

  .sessions article {
    display: flex;
    align-items: stretch;
    gap: 8px;
    border: 1px solid #d9dee3;
    border-radius: 6px;
    background: #ffffff;
  }

  .sessions article button {
    flex: 1;
    background: transparent;
    border: 0;
    padding: 10px 12px;
    text-align: left;
    cursor: pointer;
  }
  .sessions article button strong {
    display: block;
    font-size: 13px;
  }
  .sessions article button .meta {
    display: block;
    color: #5a6672;
    font-size: 11px;
    margin-top: 4px;
  }

  .sessions article.active {
    border-color: #2563eb;
    box-shadow: 0 0 0 1px #2563eb33;
  }

  .sessions .stop {
    flex: 0;
    border-left: 1px solid #d9dee3;
    background: transparent;
    padding: 0 12px;
    cursor: pointer;
    color: #b6373b;
  }

  .sessions .error {
    color: #b6373b;
    font-size: 12px;
  }

  .sessions .muted {
    color: #5a6672;
    font-size: 13px;
  }

  .sessions form.create {
    margin-top: 12px;
    padding: 12px;
    border: 1px dashed #c5ccd2;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #fdfdff;
  }

  .sessions form.create label {
    display: flex;
    flex-direction: column;
    font-size: 12px;
    gap: 4px;
  }
  .sessions form.create select,
  .sessions form.create input {
    padding: 6px 8px;
    border: 1px solid #c5ccd2;
    border-radius: 4px;
    font: inherit;
  }

  .terminal {
    display: grid;
    grid-template-rows: auto 1fr;
    background: #0e151c;
    color: #d7e1ea;
    min-width: 0;
  }
  .terminal-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid #2c3946;
    color: #9fb0bf;
    font-size: 12px;
  }
  .terminal-bar button {
    background: transparent;
    color: inherit;
    border: 1px solid #2c3946;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .xterm {
    height: 100%;
    width: 100%;
  }
  .placeholder {
    padding: 32px;
    color: #6f7d89;
  }
</style>
