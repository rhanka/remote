# remote migrate — local ↔ remote session round-trip

`remote migrate` is a convenience wrapper that automates the full round-trip of
moving a local CLI session (codex / claude / agy / opencode) onto a remote
Scaleway Kapsule cluster and pulling it back when you are done.

## Prerequisites

1. **Remote URL configured** — either via `remote config set <url>` or the
   `--remote <url>` flag.
2. **Credentials pushed** — run `remote auth push <sessionId>` (or rely on
   the automatic bundling that happens during session creation) so that the
   remote Pod has the profile's API keys.
3. **Workspace linked** (optional but recommended) — `remote workspace link`
   creates a `.remote/workspace.json` in the project root and allocates a
   persistent PVC for your files. If the cwd is not yet linked, `migrate`
   creates and links a workspace automatically.

---

## Forward: local → remote

```
remote migrate forward <profile> [--remote <url>] [--workspace <id>] [--resume [convId]]
```

### What it does

1. Resolves the remote URL (from `--remote` or `remote config show`).
2. Ensures the cwd is linked to a workspace (reads `.remote/workspace.json`;
   uses `--workspace <id>` override; or creates + links a new workspace).
3. **Pushes the workspace**: archives the project files (respecting `.gitignore`)
   and uploads them to the remote PVC via a short-lived shell session — the same
   mechanism as `remote workspace push`.
4. **Creates a remote session** for `<profile>` bound to that workspace. When
   `--resume [convId]` is given, the profile's native resume flag (`--resume` /
   `--continue`) is passed to the remote CLI so it picks up the conversation
   where you left off.
5. **Hands off the terminal**: calls `attach`, which takes over stdin/stdout of
   the current process in raw mode and streams I/O to the remote PTY. A banner
   is printed before the handoff:

   ```
   [remote] terminal is now REMOTE — press Ctrl+P Ctrl+Q to detach without stopping the session
   ```

### Terminal handoff — what it means and its limits

`migrate forward` does **not** spawn a child process or background daemon.
`attach` takes over the **current** terminal (the process running `remote
migrate forward`) and blocks until the remote session ends or you press
**Ctrl+P Ctrl+Q** to detach. There is no other process to kill and no shell to
return to — when attach exits, the `remote migrate forward` process exits.

Detaching (Ctrl+P Ctrl+Q) leaves the remote session running. You can re-attach
later with `remote attach [url] <sessionId>`.

### Example

```bash
# Inside your project directory
remote migrate forward claude --resume
```

This links the cwd to a workspace (or reuses the existing one), pushes your
files, starts a `claude` session on the cluster, and immediately hands the
terminal over. The remote Claude picks up your last conversation.

---

## Back: remote → local

```
remote migrate back [--remote <url>] [--workspace <id>] [--on-conflict <mode>]
```

### What it does

1. Resolves the remote URL + workspace id (from `.remote/workspace.json` or
   `--workspace`).
2. **Pulls the workspace**: starts a short-lived shell session with
   `workspaceExport: true`, downloads the PVC archive, and 3-way merges it into
   the cwd (base snapshot is the last push). Conversation state stored under
   `.remote/sessions/` in the archive is restored to the local HOME via the
   same logic as `remote workspace pull --restore-sessions`.
3. **Stops the remote session** — finds the most-recent session on the remote
   control-plane and issues a stop request with reason `migrate-back`.
4. **Prints the resume command** — does NOT spawn the local CLI; instead prints
   the exact command to run, e.g.:

   ```
   [remote] resume your session with:

     remote claude --resume
   ```

### Conflict resolution

When both local and remote have diverged for the same file or conversation:

| `--on-conflict` | behaviour |
|---|---|
| (omitted — default) | block: leave conflict markers, exit 1 |
| `backup` | duplicate local under a fresh conversation id, then take remote |
| `keep-local` | discard remote changes for diverged items |

### Example

```bash
# After working remotely, pull back and continue locally
remote migrate back --on-conflict backup
# Follow the printed resume command, e.g.:
remote claude --resume
```

---

## Full project migration example (SCW Kapsule)

```bash
# 1. Set the remote URL (once)
remote config set https://remote.example.com

# 2. Link the project
cd ~/projects/myapp
remote workspace link --name myapp

# 3. Push local auth credentials so the remote session has them
remote auth push <any-running-session-id> --all
# (or just use the auto-bundling in migrate forward)

# 4. Migrate to remote — terminal hands off
remote migrate forward claude --resume

# ... work on the remote cluster ...

# 5. Pull back (run in a NEW terminal on your laptop)
cd ~/projects/myapp
remote migrate back --on-conflict backup

# 6. Continue locally
remote claude --resume
```

---

## Flags summary

### `migrate forward <profile>`

| Flag | Description |
|---|---|
| `--remote <url>` | Control-plane URL (defaults to `remote config show`) |
| `--workspace <id>` | Bind to a specific workspace id (default: `.remote/workspace.json`) |
| `-r, --resume [convId]` | Pass the profile's native resume flag to the remote CLI |

### `migrate back`

| Flag | Description |
|---|---|
| `--remote <url>` | Control-plane URL (defaults to `remote config show`) |
| `--workspace <id>` | Pull from a specific workspace id (default: `.remote/workspace.json`) |
| `--on-conflict <mode>` | `backup` or `keep-local` (default: block) |
