<script lang="ts">
  import { CLI_PROFILES } from "@remote-controle/protocol";

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
</style>
