# UAT — Sentropic Remote MVP sur k3d local

État du repo : `main` à `5d5bc02` (21 commits poussés le 2026-05-15).

## Finalité

Valider Track 2 (refresh credentials d'une session distante existante) en condition UAT, avec `remote` comme **seule** interface d'interaction opérationnelle.

## Règle d'exécution

- Toute la séquence UAT opérationnelle (precheck, création, refresh, attach, stop, cleanup) utilise **exclusivement** des commandes `remote`.
- Les commandes `make` / `kubectl` / `k3d` apparaissent uniquement dans les sections explicitement marquées **« Infra prep (hors UAT) »** et **« Diagnostic optionnel (hors UAT) »**.
- L'URL du remote n'est jamais répétée : elle est posée une fois par `remote config set` puis consommée implicitement.

## État du service à tester

- API control-plane Sentropic Remote exposée localement sur `localhost:8080`.
- Endpoints couverts : création / listing / attach / refresh / stop de sessions, injection de credentials, relance Pod sur refresh.
- Code en test : `protocol` + `control-plane` + `k8s-orchestrator` + `session-agent` + `remote-cli`.

## État d'entrée

- `make demo` terminé (ou équivalent `k3d-up + images + deploy`).
- Port-forward control-plane actif (`make port-forward`).
- Aucune session distante active, ou bien IDs connus et suivis via `remote ls`.

## Pré-requis poste

- Node 22, npm 11 (corepack).
- Docker daemon.
- k3d (`~/.local/bin/k3d`).
- kubectl (snap).
- CLIs natives installées : `codex`, `claude`, `agy` (Antigravity CLI — au moins une avec credentials valides dans `~/.<cli>/` ou `~/.gemini/`).

## Infra prep (hors UAT) — setup one-shot

```bash
cd ~/src/remote
make install          # npm install (workspaces)
make verify           # format + lint + typecheck + build + test (~3-4 min)
make cli-link         # 'remote' dans $PATH via npm link
make demo             # k3d-up + images + k3d-load + deploy + wait-ready (~5-8 min)
```

Si déjà fait :

```bash
make k3d-load         # rebuild + reload des deux images
kubectl -n sentropic-remote rollout restart deploy/control-plane
make port-forward     # garde ce shell ouvert
```

## Préparation UAT (obligatoire — 1 fois par poste)

```bash
remote config set http://localhost:8080
# alias équivalent : remote install http://localhost:8080
remote config show
remote ls
```

Attendu :

- `remote config show` affiche `http://localhost:8080`.
- `remote ls` répond `[remote] no sessions` (service prêt) ou liste des sessions existantes.
- Toutes les commandes `remote` suivantes peuvent omettre l'URL.

Si `remote ls` échoue avec un `ECONNREFUSED` : le port-forward n'est pas actif → revoir l'« Infra prep ». Pas de poursuite UAT tant que `remote ls` ne répond pas proprement.

## Scénarios

### 1. Mode local pur (sans k3s, control-plane in-process)

```bash
remote codex                  # spawn codex via PTY, UX identique à 'codex' direct
remote claude                 # idem pour claude (alias claude-code)
remote agy                    # idem pour Antigravity CLI (alias antigravity)
remote codex --resume <sid>   # reprend une session codex existante (--continue côté codex)
```

**Attendu :** TUI du CLI s'affiche, comportement identique à un lancement direct. Le `[remote] session sess-xxx attach at http://127.0.0.1:<port>` annonce le port operator.

### 2. Mode remote (Pod k3s, credentials auto-bundlés)

Préflight local sans création de Pod :

```bash
remote auth codex
remote auth claude
```

**Attendu :**

- `auth status: ok: ...`
- `bundled files: N` avec N > 0 pour Codex/Claude.
- Aucun contenu de secret affiché.

Smoke non interactif (recommandé avant TUI) :

```bash
remote smoke codex
remote smoke claude
```

**Attendu :**

- création d'une session remote avec credentials bundlés ;
- réception de `terminal.opened` depuis le Pod ;
- stop automatique de la session ;
- sortie sans contenu de secret : `profile`, `session`, `terminal`, `shell`, `stopped: true`.

Mode interactif :

```bash
remote codex --remote
```

**Attendu :**

- `[remote] auth status ok: codex login status`.
- `[remote] bundled N auth file(s) for codex` (N = 2 si `~/.codex/auth.json` et `~/.codex/config.toml` existent).
- `[remote] attached to <remote>/sessions/sess-xxx`.
- Codex démarre dans le Pod, lit `/root/.codex/auth.json`, **TUI s'affiche déjà loggée**.

### 3. Mode remote sans auth (vérif que codex râle proprement)

```bash
remote codex --remote --no-auth
```

**Attendu :** Codex se lance, n'a pas de credentials → propose une procédure de login → coince sur le callback localhost (bug connu, voir « Limitations »).

### 4. Attach à une session existante

Shell A : crée une session, la laisse vivre.

```bash
remote codex --remote
# note l'ID 'sess-xxx' affiché
```

Shell B (peut être sur une autre machine si nécessaire) :

```bash
remote attach sess-xxx
```

**Attendu :** Shell B voit le terminal de la session, peut taper, les frappes vont au même Pod, les outputs sont mirrorés sur les 2 shells.

### 5. Profiles claude / antigravity

```bash
remote claude --remote
remote agy --remote
```

**Attendu :**

- `~/.claude/.credentials.json` / `~/.gemini/oauth_creds.json` + `~/.gemini/google_accounts.json` + `~/.gemini/antigravity-cli/settings.json` bundlés et montés sous `/root/`.
- Claude bascule normalement en flow « copy-paste code » si le browser n'est pas dispo dans le Pod (à confirmer pendant l'UAT).
- Antigravity (`agy`) : OAuth persisté en keyring système hors conteneur ; si les credentials gemini-shared ne suffisent pas, `agy` détecte la session SSH et imprime une URL d'auth à compléter localement (à confirmer pendant l'UAT).

### 6. Track 2 — Secrets refresh (cœur UAT)

Séquence 100 % `remote`, sans URL répétée.

Précondition : `remote ls` doit afficher au moins une session vivante (sinon, créer via étape ① ci-dessous).

```bash
# ① ouvrir une session distante et noter l'ID
remote codex --remote
# → [remote] attached to .../sessions/<sid>

# ② vérifier que la session est listée
remote ls

# ③ déclencher le refresh des credentials
remote refresh <sid> --profile codex
# (équivalent sans --profile : remote refresh <sid> → profile auto-détecté côté control-plane)

# ④ confirmer que la session reste accessible
remote attach <sid>
```

Attendu :

- précheck local exécuté (`codex login status`) puis upload des nouveaux fichiers connus.
- `[remote] refresh accepted for <sid>`.
- la session repasse par `starting` puis revient `running` (visible via `remote ls` ou via SSE côté operator-UI quand dispo).
- `remote attach <sid>` retrouve un terminal fonctionnel sans intervention manuelle.

### 7. Cycle de vie

```bash
remote ls
remote stop <sid> --reason uat
remote ls            # le sid a disparu de la liste
```

Attendu :

- `[remote] stop accepted for <sid>`.
- `remote ls` ne liste plus la session.

## Diagnostic optionnel (hors UAT)

À n'exécuter que si une anomalie est observée pendant le scénario 6 ou 7.

```bash
kubectl -n sentropic-remote get pod session-<sid> -o wide
kubectl -n sentropic-remote get secret session-<sid>-auth
kubectl -n sentropic-remote get events --field-selector involvedObject.name=session-<sid> \
  --sort-by=.lastTimestamp | tail -n 30
```

## Cleanup

Cleanup UAT (recommandé) :

```bash
remote ls
remote stop <sid> --reason uat-cleanup
```

Cleanup infra (hors UAT, si on rend la machine) :

```bash
make demo-down
```

## Limitations connues

- **OAuth callback localhost** : codex/antigravity ne peuvent pas re-authentifier dans le Pod sans port-forward inverse. Workaround : pré-provisioner les credentials via `--remote`. `remote codex --remote` lance `codex login status` localement avant de bundler, et `remote claude --remote` lance `claude auth status`. Si le preflight échoue, relancer `codex login` ou `claude auth login` localement puis réessayer. Pour bypasser le preflight : `--no-auth-refresh`.
- **Antigravity auth refresh** : pas de commande de statut non interactive connue ; on bundle `~/.gemini/oauth_creds.json` / `~/.gemini/google_accounts.json` / `~/.gemini/antigravity-cli/settings.json`. `agy` privilégie sinon le keyring système — en SSH/Pod il bascule sur l'URL d'auth à compléter localement.
- **Claude paste flow** : sur gcloud console ça a fonctionné ; à confirmer ici via le scénario 5.
- **Limites de fichiers bundlés** : seulement les paths connus dans `PROFILE_AUTH_FILES` (`packages/remote-cli/src/auth-bundle.ts`). Codex/Claude échouent avant création de Pod si aucun fichier credential connu n'est trouvé ; pour ajouter d'autres paths, enrichir cette liste.
- **TTY resize remote → agent** : Operator UI et `remote attach` propagent `POST /sessions/:id/terminal/resize` ; à valider visuellement pendant Codex/Claude/Antigravity.
- **Replay d'events SSE** : le control-plane rejoue un backlog court aux subscribers tardifs et le purge après stop de session.

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
| Track 2 secrets refresh | ✅   | endpoint `/sessions/:id/credentials` + `remote refresh` + relance Pod |
| Track 3 Scaleway        | ⏸    | Manifests overlay + image push GHCR à faire                          |
| Track 4 operator-UI     | ⏸    | xterm.js sur SSE, à faire                                            |
