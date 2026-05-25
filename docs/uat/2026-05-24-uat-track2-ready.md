# UAT Track 2 — Sentropic Remote (prêt à exécuter)

Date : 2026-05-24
Cluster : k3d local `sentropic-remote` (port-forward `localhost:8080`)
Profils validés : `codex`, `claude`, `antigravity` (`agy`)

> **Tout est déjà préparé.** Cluster up, control-plane up, port-forward up, `remote config` posé, images `:v0.1.3` locales (avec `agy`) importées, pull policy = `IfNotPresent`.
> Si quoi que ce soit plante, va à la fin du doc § « Si l'env est tombé ».

## Green-light (1 commande, < 5 s)

```bash
remote ls
```

**Attendu** : `[remote] no sessions` (ou liste des sessions existantes).
Toute autre sortie = env cassé → § « Si l'env est tombé ».

## Séquence UAT (100 % `remote`)

Ordre conseillé : `codex` d'abord (preflight le plus fiable), puis `claude`, puis `antigravity`.

### 1. Diagnostic local (sans créer de Pod)

```bash
remote auth status codex
remote auth status claude
remote auth status agy
# ou tout d'un coup : remote auth status --all
```

**Attendu** :

```
profile: codex
auth status: ok: codex login status
bundled files: 2
- .codex/auth.json
- .codex/config.toml

profile: claude-code
auth status: ok: claude auth status
bundled files: 1
- .claude/.credentials.json

profile: antigravity
auth status: skipped: no-status-command
bundled files: 3
- .gemini/oauth_creds.json
- .gemini/google_accounts.json
- .gemini/antigravity-cli/settings.json
```

### 2. Smoke non interactif (création + terminal.opened + stop auto)

```bash
remote smoke codex
remote smoke claude
remote smoke antigravity
```

**Attendu** (par profil) :

```
profile: <profile>
session: sess-XXXXXXXX
terminal: term-XXXXXXXX
shell: <codex|claude|agy>
stopped: true
```

> Si `shell:` affiche `/bin/bash` pour `antigravity` → l'image dans le cluster n'est pas la bonne. Cf. § « Si l'env est tombé ».

### 3. Track 2 — Refresh credentials sur session vivante

#### 3.1 Ouvrir une session interactive (shell A)

```bash
remote codex --remote
```

**Attendu** :

```
[remote] auth status ok: codex login status
[remote] bundled 2 auth file(s) for codex
[remote] attached to http://localhost:8080/sessions/sess-XXXXXXXX
```

TUI codex s'affiche, **déjà loggée** (lit `/root/.codex/auth.json` bundlé).
Note l'ID `sess-XXXXXXXX`. Laisse ce shell ouvert.

#### 3.2 Lister depuis un autre shell (shell B)

```bash
remote ls
```

**Attendu** : 1 ligne avec `sess-XXXXXXXX`, profile=codex, target=k3s.

#### 3.3 Refresh des credentials (shell B)

```bash
remote refresh <sid> --profile codex
```

**Attendu** :

```
[remote] auth status ok: codex login status
[remote] refresh accepted for sess-XXXXXXXX
```

**Effet observé** : le Pod `session-<sid>` est relancé (cycle `running` → `starting` → `running`). Le secret `session-<sid>-auth` est recréé avec les nouveaux fichiers.

#### 3.4 Variante sans `--profile` (profil auto-détecté)

```bash
remote refresh <sid>
```

**Attendu** : même réponse `refresh accepted`, le control-plane lit `descriptor.profile` côté session pour choisir quoi bundler.

#### 3.5 Attach depuis shell B après refresh

```bash
remote attach <sid>
```

**Attendu** : shell B se connecte au même terminal. Frappes shell B → vues shell A et inversement.

### 4. Cycle de vie

```bash
remote stop <sid> --reason uat
remote ls
```

**Attendu** :

```
[remote] stop accepted for sess-XXXXXXXX
[remote] no sessions
```

Le Pod, le PVC `workspace` et le Secret `session-<sid>-auth` sont supprimés en cascade par le control-plane.

### 5. Répéter pour `claude` et `antigravity`

Même séquence, en remplaçant `codex` par `claude` puis `agy` (alias de `antigravity`) :

```bash
remote claude --remote          # shell A
remote ls                       # shell B
remote refresh <sid> --profile claude-code
remote attach <sid>             # optionnel
remote stop <sid> --reason uat

remote agy --remote             # shell A
remote ls                       # shell B
remote refresh <sid>            # profile auto-détecté → antigravity
remote attach <sid>
remote stop <sid> --reason uat
```

> Cas particulier `agy` : pas de `auth status` non interactif côté CLI ; le bundle pousse `~/.gemini/oauth_creds.json` + `google_accounts.json` + `~/.gemini/antigravity-cli/settings.json`. Si `agy` ne sait pas s'authentifier malgré le bundle, il imprime une URL OAuth dans le terminal — à compléter localement.

## Cleanup final

```bash
remote ls
# pour chaque sess-XXXXXXXX restant :
remote stop <sid> --reason uat-cleanup
```

## Si l'env est tombé

Symptômes :

- `remote ls` répond `fetch failed` ou `ECONNREFUSED 127.0.0.1:8080`
- `remote smoke antigravity` rend `shell: /bin/bash`
- une session reste en `ContainerCreating` plus de 30 s

Diagnostic minimal (hors UAT, 3 commandes) :

```bash
kubectl -n sentropic-remote get pods
ss -ltnp | grep :8080
docker exec k3d-sentropic-remote-server-0 crictl images | grep sentropic-remote
```

Attendus :

- 1 pod `control-plane-*` `Running`, pas de session-* `Pending`.
- 1 listener sur `127.0.0.1:8080` (port-forward kubectl).
- `session-agent:v0.1.3` avec une taille **~1.18 GB** (ma version locale avec `agy`). Si tu vois `~353 MB`, c'est l'ancienne image GHCR — kubectl a écrasé l'import.

Remise en route en 3 étapes (toujours hors UAT) :

```bash
# 1. Port-forward si tué
kubectl -n sentropic-remote port-forward svc/sentropic-remote-control-plane 8080:8080 &

# 2. Image session-agent éclipsée par GHCR
k3d image import ghcr.io/rhanka/sentropic-remote-session-agent:v0.1.3 -c sentropic-remote

# 3. Confirme : taille ~1.18 GB et pull policy IfNotPresent
docker exec k3d-sentropic-remote-server-0 crictl images | grep session-agent
kubectl -n sentropic-remote get deploy control-plane -o jsonpath='{.spec.template.spec.containers[0].env}' | tr ',' '\n' | grep PULL_POLICY
```

Si l'override `SESSION_AGENT_IMAGE_PULL_POLICY=IfNotPresent` n'est pas posé :

```bash
kubectl -n sentropic-remote set env deploy/control-plane SESSION_AGENT_IMAGE_PULL_POLICY=IfNotPresent
kubectl -n sentropic-remote rollout status deploy/control-plane --timeout=60s
```

Puis reprends à `remote ls`.

## Statut connu (pour info, pas pour exécution)

| Profil       | Bundle creds                                                | Auth preflight        | Smoke k3d |
| ------------ | ----------------------------------------------------------- | --------------------- | --------- |
| `codex`      | `.codex/auth.json`, `.codex/config.toml`                    | `codex login status`  | ✅ `shell: codex` |
| `claude`     | `.claude/.credentials.json`                                 | `claude auth status`  | ✅ `shell: claude` |
| `antigravity`| `.gemini/oauth_creds.json` + `google_accounts.json` + `antigravity-cli/settings.json` | aucun (interactif uniquement) | ✅ `shell: agy` |
