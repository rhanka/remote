# Design note — `remote auth` verbs (UX redesign)

Date: 2026-05-24
Status: draft for review (Q/R)
Feedback origin: `docs/uat/2026-05-24-feedback-track2.md` §1

## Problem

Today `remote <profile> --remote` silently bundles local credential files
(`~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.gemini/*`) into the
remote session Secret. The user wants:

1. **Explicit, responsible** credential movement (no silent copy off the machine).
2. Verbs/flags that name the direction (export vs import).
3. A `--all` to push every profile at once.
4. A path for **"not authenticated locally yet"** (guide or drive enrollment).

`remote auth <profile>` exists today but is **diagnostic only** (prints status +
which files would be bundled). It does not move anything.

## What other CLIs do

| CLI | Login | Status | Token egress | Notable |
| --- | --- | --- | --- | --- |
| `gh` | `gh auth login` (interactive, device/web) | `gh auth status` | `gh auth token` (prints), `gh auth setup-git` | `gh auth switch` between accounts |
| `gcloud` | `gcloud auth login` / `application-default login` | `gcloud auth list` | ADC file written to known path | separate "app default" creds |
| `docker` | `docker login` (writes `~/.docker/config.json`) | — | — | registry-scoped |
| `fly` | `fly auth login` | `fly auth whoami` | `fly auth token` | — |
| `ssh` | n/a | n/a | `ssh-copy-id` (push pubkey to host) | explicit host-targeted copy |

Takeaways:
- **Verb = `auth`, sub-actions = sub-verbs** (`login`, `status`, `token`) is the
  dominant pattern. Direction is implied by the sub-verb, not a `--export` flag.
- Pushing a secret *to a remote host* is rare in these tools; the closest analog
  is `ssh-copy-id` — an explicit, host-targeted, named action.
- None silently exfiltrate; the act of moving a credential is always an explicit
  command the user typed.

## Options

### Option A — Keep implicit bundling, add a confirmation gate

`remote codex --remote` still bundles, but prints what it's about to send and
asks `Send 2 file(s) (~/.codex/auth.json, ~/.codex/config.toml) to <remote>? [y/N]`
unless `--yes`. `remote auth <profile>` stays diagnostic.

- ➕ Smallest change; keeps the one-command flow.
- ➖ Confirmation fatigue; still couples "run" and "send creds".
- ➖ Doesn't give a standalone "push my creds" or `--all`.

### Option B — Sub-verbs under `auth` (ssh-copy-id style) — **recommended**

```
remote auth status [profile]          # current diagnostic (default action)
remote auth push <profile> [--all]    # export local creds → remote session Secret
remote auth login <profile>           # drive/guide local enrollment, then offer push
```

- `remote codex --remote` keeps auto-bundling **but** with a one-line disclosure
  (`[remote] sending codex creds to <remote> (remote auth push to do this explicitly)`).
- `remote auth push --all` iterates every profile that has local creds.
- `remote auth login codex` runs the local enrollment (`codex login`,
  `claude auth login`; for `agy` prints the SSH-mode URL), then asks to push.

- ➕ Named, explicit, matches `gh`/`ssh-copy-id` mental model.
- ➕ `--all` and the not-auth-local path fall out naturally.
- ➖ More surface (3 sub-verbs) + docs.

### Option C — Direction flags on the existing verb

`remote auth --export <profile>` / `--import <profile>` / `--all`.

- ➕ Single verb.
- ➖ `--import` is ambiguous (import *to where*?); flags-as-direction reads worse
  than sub-verbs; diverges from the `gh auth <subverb>` norm the user's other
  tools use.

## Cross-cutting decisions (apply to whichever option)

- **Disclosure line** whenever creds leave the machine, naming files + target.
  Never print secret *contents* (already the case).
- **`--no-auth`** stays the escape hatch (start a session with zero creds).
- **Not-authenticated-local**: detect (the preflight `codex login status` /
  `claude auth status` already does for codex/claude; `agy` has none) and, when
  missing, print the exact local command to run rather than failing opaquely.
- **`refresh`** (already shipped) is the "update creds on a live session"
  counterpart to `auth push` (which is "seed creds at create time").

## Recommendation

**Option B.** It matches the CLIs the user already lives in (`gh`, `ssh-copy-id`),
makes egress explicit and named, and absorbs `--all` + the not-auth path without
contorting flags. Keep the one-command `--remote` flow with a disclosure line so
velocity isn't lost.
