# Déploiement Sentropic Remote sur le cluster Kapsule `poc`

Suite du UAT local — déploie sur le cluster Scaleway `poc` (`979c11ad-9f84-4847-a334-c42a5e797976`, fr-par-2, 1× DEV1-M, géré par `~/src/poc-k8s`).

## Finalité

Exécuter Track 2 (refresh credentials d'une session distante) dans l'environnement `poc-k8s`, avec `remote` comme **seule** interface opérationnelle.

## Règle d'exécution

- Toute la séquence UAT opérationnelle (precheck, création, refresh, attach, stop, cleanup) utilise **exclusivement** les commandes `remote`.
- Les commandes `make` / `kubectl` / `scw` n'apparaissent que dans les sections explicitement marquées **« Infra prep (hors UAT) »** et **« Retour à zéro infra (hors UAT) »**.
- L'URL du remote n'est jamais répétée : posée une fois via `remote config set`, elle est ensuite consommée implicitement.

## État du service à tester

- API control-plane Sentropic Remote déployée en namespace `sentropic-remote`.
- Contrôles à valider : listing sessions (`ls`), rafraîchissement credentials (`refresh`), attach (`attach`), arrêt (`stop`), stabilité lifecycle.

## État d'entrée de l'environnement

- Kubeconfig prêt : `~/.kube/poc.yaml`.
- Déploiement fait via `make scw-deploy` (cf. infra prep).
- Port-forward actif (`make scw-port-forward`).
- `remote config set http://localhost:8080` exécuté une fois pour la session UAT.

## Infra prep (hors UAT)

Au premier push, les images `ghcr.io/rhanka/sentropic-remote-{control-plane,session-agent}` sont **privées**. Deux options :

### Option A — Rendre publiques (recommandé pour POC)

Via UI :

- <https://github.com/users/rhanka/packages/container/sentropic-remote-control-plane/settings> → bas de page → **Change visibility** → Public
- pareil pour `sentropic-remote-session-agent`

Ou via API (nécessite `write:packages` scope — `gh auth refresh -s write:packages`) :

```bash
gh api -X PATCH /user/packages/container/sentropic-remote-control-plane \
  --field visibility=public
gh api -X PATCH /user/packages/container/sentropic-remote-session-agent \
  --field visibility=public
```

### Option B — Garder privées + imagePullSecret

```bash
PAT=$(gh auth token)   # ou un PAT dédié avec read:packages
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=rhanka \
  --docker-password="$PAT"
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote patch sa sentropic-remote-control-plane \
  -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote patch sa default \
  -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
```

### Déploiement control-plane

Depuis `~/src/remote/` :

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-deploy
# Optionnel : SCW_INGRESS=1 si DNS + cert-manager déjà installés
```

Le namespace `sentropic-remote` est déjà créé par `poc-k8s`. `make scw-deploy` réapplique son namespace (idempotent) puis RBAC + Deployment + Service.

### Port-forward d'accès

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-port-forward
# garde ce shell ouvert pendant toute la séquence UAT
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

## UAT Track 2 — Séquence (100 % `remote`)

Séquence minimale, sans URL répétée :

```bash
# ① ouvrir une session distante sur le cluster Scaleway
remote codex --remote --target scaleway-kapsule
# → note l'ID 'sess-xxx' dans "[remote] attached to .../sessions/<sid>"

# ② vérifier que la session est listée
remote ls

# ③ déclencher le refresh des credentials
remote refresh <sid> --profile codex
# (équivalent sans --profile : remote refresh <sid> → profile auto-détecté côté control-plane)

# ④ confirmer que la session reste accessible après refresh
remote attach <sid>

# ⑤ stop propre de la session
remote stop <sid> --reason uat
```

Attendus :

- précheck local OK (`codex login status` ou `claude auth status` selon le profil).
- `[remote] refresh accepted for <sid>`.
- la session repasse par `starting` puis revient `running` (visible via `remote ls` ou via SSE côté operator-UI quand dispo).
- `remote attach <sid>` ré-affiche la même session sans passer par une URL manuelle.
- `[remote] stop accepted for <sid>`, puis `remote ls` ne liste plus la session.

## Diagnostic optionnel (hors UAT)

À n'exécuter que si une anomalie est observée pendant la séquence.

```bash
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote get pod session-<sid> -o wide
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote get secret session-<sid>-auth
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote get events \
  --field-selector involvedObject.name=session-<sid> \
  --sort-by=.lastTimestamp | tail -n 30
```

## Cleanup

Cleanup UAT (recommandé) :

```bash
remote ls
remote stop <sid> --reason uat-cleanup
```

## Retour à zéro infra (hors UAT)

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-undeploy   # retire le Deployment, conserve namespace/quotas
scw k8s cluster delete 979c11ad-9f84-4847-a334-c42a5e797976
```
