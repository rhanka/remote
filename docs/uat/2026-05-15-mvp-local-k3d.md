# UAT — Sentropic Remote MVP sur k3d local

État du repo : `main` à `5d5bc02` (21 commits poussés le 2026-05-15).

## Pré-requis

- Node 22, npm 11 (corepack)
- Docker daemon
- k3d (`~/.local/bin/k3d` chez l'auteur)
- kubectl (snap)
- CLIs natives installées en local : `codex`, `claude`, `gemini` (au moins une avec des credentials valides dans son répertoire `~/.<cli>/`)

## Setup one-shot

```bash
cd ~/src/remote
make install          # npm install (workspaces)
make verify           # format + lint + typecheck + build + test (~3-4 min)
make cli-link         # 'remote' dans $PATH via npm link
make demo             # k3d-up + images + k3d-load + deploy + wait-ready (~5-8 min)
```

Si déjà fait :

```bash
make k3d-load         # rebuild + reload des deux images (control-plane + session-agent)
kubectl -n sentropic-remote rollout restart deploy/control-plane
make port-forward     # garde ce shell ouvert
```

## Scénarios

### 1. Mode local pur (sans k3s, control-plane in-process)

```bash
remote codex                  # spawn codex via PTY, UX identique à 'codex' direct
remote claude                 # idem pour claude (alias claude-code)
remote gemini                 # idem pour gemini (alias gemini-cli)
remote codex --resume <sid>   # reprend une session codex existante (--continue côté codex)
```

**Attendu :** TUI du CLI s'affiche, comportement identique à un lancement direct. Le `[remote] session sess-xxx attach at http://127.0.0.1:<port>` annonce le port operator.

### 2. Mode remote (Pod k3s, credentials auto-bundlés)

Shell A :

```bash
make port-forward
```

Shell B (interactif) :

```bash
remote codex --remote http://localhost:8080
```

**Attendu :**

- `[remote] auth status ok: codex login status`.
- `[remote] bundled N auth file(s) for codex` (N = 2 si `~/.codex/auth.json` et `~/.codex/config.toml` existent).
- `[remote] attached to http://localhost:8080/sessions/sess-xxx`.
- Pod `session-sess-xxx` créé (`kubectl -n sentropic-remote get pods` dans un 3e shell).
- Codex démarre dans le Pod, lit `/root/.codex/auth.json` (le tien), **TUI s'affiche déjà loggée**.

Vérifications :

```bash
# le Secret a été créé
kubectl -n sentropic-remote get secret session-<sid>-auth

# le fichier est bien monté dans le Pod (readonly mode 0400)
kubectl -n sentropic-remote exec session-<sid> -- ls -la /root/.codex/auth.json

# l'event lifecycle a bien transité requested -> provisioning -> starting -> ready
curl -sN http://localhost:8080/sessions/<sid>/events | head -c 2000
```

### 3. Mode remote sans auth (vérif que codex râle proprement)

```bash
remote codex --remote http://localhost:8080 --no-auth
```

**Attendu :** Codex se lance, n'a pas de credentials → propose une procédure de login → coince sur le callback localhost (c'est le bug connu, voir « Limitations »).

### 4. Attach à une session existante

Shell A : crée une session, la laisse vivre.

```bash
remote codex --remote http://localhost:8080
# note l'ID 'sess-xxx' affiché
```

Shell B (peut être sur une autre machine si tu changes l'URL) :

```bash
remote attach http://localhost:8080 sess-xxx
```

**Attendu :** Shell B voit le terminal de la session, peut taper, les frappes vont au même Pod, les outputs sont mirrorés sur les 2 shells.

### 5. Profiles claude / gemini

```bash
remote claude --remote http://localhost:8080
remote gemini --remote http://localhost:8080
```

**Attendu :**

- `~/.claude/.credentials.json` / `~/.gemini/oauth_creds.json` bundlés et montés sous `/root/`.
- Claude bascule normalement en flow « copy-paste code » si le browser n'est pas dispo dans le Pod (à confirmer pendant l'UAT).
- Gemini : à observer ; possible que ça coince sur callback aussi.

### 6. Cycle de vie

```bash
# liste via remote-cli
remote ls http://localhost:8080

# stop via remote-cli
remote stop http://localhost:8080 <sid> --reason uat

# le Pod, le PVC, le Secret disparaissent dans la foulée
kubectl -n sentropic-remote get pods,pvc,secrets | grep <sid>
```

## Limitations connues

- **OAuth callback localhost** : codex/gemini ne peuvent pas re-authentifier dans le Pod sans port-forward inverse. Workaround : pré-provisioner les credentials via `--remote` (par défaut). `remote codex --remote ...` lance maintenant `codex login status` localement avant de bundler les fichiers, et `remote claude --remote ...` lance `claude auth status`. Si le preflight échoue, relance `codex login` ou `claude auth login` localement puis réessaie. Pour bypasser le preflight : `--no-auth-refresh`.
- **Gemini auth refresh** : pas de commande de statut non interactive fiable observée localement ; pour l'instant on continue à bundler `~/.gemini/oauth_creds.json` / `~/.gemini/google_accounts.json` et l'UAT Gemini doit confirmer le comportement.
- **Claude paste flow** : sur gcloud console ça a marché ; à confirmer ici via l'UAT scénario 5.
- **Limites de fichiers bundlés** : seulement les paths connus dans `PROFILE_AUTH_FILES` (`packages/remote-cli/src/auth-bundle.ts`). Si un CLI utilise d'autres paths, l'enrichir.
- **Pas de TTY resize remote → agent** : un futur `POST /sessions/:id/terminal/resize` est planifié.
- **Pas de réplay d'events** : un subscriber SSE arrivé tard manque les premiers events lifecycle.

## Cleanup

```bash
# session-par-session
curl -s -X POST http://localhost:8080/sessions/<sid>/stop -d '{}' -H 'content-type: application/json'

# tout le cluster
make demo-down
```

## Statut

| Track                   | État | Notes                                                                |
| ----------------------- | ---- | -------------------------------------------------------------------- |
| Plan 1 protocol         | ✅   | 25 tests Ajv, OpenAPI 3.1                                            |
| Plan 2 control-plane    | ✅   | REST + SSE + WS, AgentRegistry, 15 tests                             |
| Plan 3 orchestrator     | ✅   | InMemory + K8s, 12 tests                                             |
| Plan 3 session-agent    | ✅   | PTY (node-pty), CLIs préinstallées, 3 tests                          |
| Plan 3 deploy           | ✅   | Dockerfiles + manifests + Makefile                                   |
| Plan 3 remote-cli       | ✅   | local + remote + attach + auto-auth, 14 tests                        |
| Plan 3 auth-bundle      | ✅   | Secret per session, vérifié dans Pod                                 |
| Track 2 secrets refresh | ⏸    | Quand tokens expirent côté Pod : pas encore de refresh côté operator |
| Track 3 Scaleway        | ⏸    | Manifests overlay + image push GHCR à faire                          |
| Track 4 operator-UI     | ⏸    | xterm.js sur SSE, à faire                                            |
