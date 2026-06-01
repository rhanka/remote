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

| `--on-conflict`     | behaviour                                                       |
| ------------------- | --------------------------------------------------------------- |
| (omitted — default) | block: leave conflict markers, exit 1                           |
| `backup`            | duplicate local under a fresh conversation id, then take remote |
| `keep-local`        | discard remote changes for diverged items                       |

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

| Flag                    | Description                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| `--remote <url>`        | Control-plane URL (defaults to `remote config show`)                |
| `--workspace <id>`      | Bind to a specific workspace id (default: `.remote/workspace.json`) |
| `-r, --resume [convId]` | Pass the profile's native resume flag to the remote CLI             |

### `migrate back`

| Flag                   | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `--remote <url>`       | Control-plane URL (defaults to `remote config show`)                  |
| `--workspace <id>`     | Pull from a specific workspace id (default: `.remote/workspace.json`) |
| `--on-conflict <mode>` | `backup` or `keep-local` (default: block)                             |

---

## Validated on Scaleway Kapsule (migration POC, 2026-05-31)

The forward path was validated end-to-end against the live SCW control-plane
(`sentropic-remote` namespace, control-plane `v0.4.1`): 5 projects pushed to 5
distinct workspaces, 5 sessions created and confirmed `Running`, project files
present in each Pod's `/workspace`, and the terminal/attach channel live
(`202 Accepted`). Gotchas worth knowing:

- **The workspace source must be a git repo.** `workspace push` / `migrate
forward` archive **git-tracked files** (`git ls-files`, respecting
  `.gitignore`). A non-git directory pushes nothing ("no files to sync"). Run
  `git init` first if needed.
- **RWX storage exists on the SCW POC cluster.** Scaleway File Storage CSI
  (`filestorage.csi.scaleway.com`) is exposed in `poc-k8s` as StorageClass
  `matchid-rwx`. The SCW manifest now requests
  `SESSION_STORAGE_CLASS=matchid-rwx`,
  `SESSION_STORAGE_ACCESS_MODE=ReadWriteMany`,
  `SESSION_WORKSPACE_SIZE=100G` (Scaleway File Storage minimum, decimal-sized),
  and schedules session Pods on
  `k8s.scaleway.com/pool-name=burst-rwx`, whose POP2 nodes are compatible with
  File Storage CSI. Do not use the older `burst` pool unless it has been
  recreated as POP2; on existing POC clusters it may still be DEV1-XL. This
  removes the Kubernetes co-mount blocker for several live session Pods on one
  workspace PVC. For several distinct workspace PVCs, keep the `burst-rwx` pool
  `max-size` at least as high as the number of active File Storage volumes; the
  5-session POC used `min-size=0`, `max-size=5`, and a temporary `size=5` after
  Kapsule reported `exceed max volume count` on three POP2 nodes. It does
  **not** remove application-level contention: for the 5-session migration POC,
  prefer one real project per workspace unless intentionally testing multi-agent
  edits on the same project.
- **Credentials are auto-bundled at session creation.** `migrate forward
<profile>` collects the local profile creds (`~/.codex/auth.json`,
  `~/.claude/.credentials.json`, `~/.gemini/oauth_creds.json`) and sends them in
  the create request — no manual `auth push` needed for a fresh session.
  `remote auth push <sessionId>` is only for **refreshing** a running session's
  creds.
- **Reaching the control-plane.** With no public ingress, port-forward it:
  `kubectl -n sentropic-remote port-forward svc/sentropic-remote-control-plane
8080:8080`, then `remote config set http://localhost:8080`. (A stable
  `remote.<domain>` ingress is the durable alternative.)
- **Capacity.** Node capacity is handled by the `burst` pool autoscaler. Before
  bulk creation, check the live `sentropic-remote` quota (`pods`, PVCs, Secrets,
  CPU/memory) because older `poc-k8s` manifests capped practical concurrency to
  4 session Pods while the target POC needs 5.

## Bulk migration checklist for real sessions

Use this when migrating several currently local projects without inventing
sessions or workspace ids:

```bash
# One terminal keeps the control-plane reachable when no public ingress is used.
make -C ../poc-k8s tenant-port-forward \
  TENANT=sentropic-remote SVC=sentropic-remote-control-plane PORT=8080
remote config set http://localhost:8080

# Prove the cluster-side RWX path before creating the batch.
make -C ../poc-k8s filestorage-csi-status
kubectl -n sentropic-remote get resourcequota,pvc,pods

# For each real project directory:
cd ~/src/<real-project>
git status --short --branch
remote workspace status || remote workspace link --name <real-project>
remote migrate forward codex --resume --no-attach

# After the batch:
remote ls
kubectl -n sentropic-remote get pods,pvc -o wide
```

`--no-attach` is the right mode for "open but not active" sessions: it creates
the remote session and prints the `remote attach <url> <sessionId>` command
without hijacking the current terminal. Reconnect a local terminal with that
attach command when you want to work in the remote PTY.
