# Déploiement Sentropic Remote sur le cluster Kapsule `poc`

Suite du UAT local — déploie sur le cluster Scaleway `poc` (`979c11ad-9f84-4847-a334-c42a5e797976`, fr-par-2, 1× DEV1-M, géré par `~/src/poc-k8s`).

## Pré-requis cluster (déjà appliqué par `make bootstrap` dans `poc-k8s`)

- Namespace `sentropic-remote` avec `ResourceQuota` + `LimitRange` + `NetworkPolicy` (cf. `~/src/poc-k8s/tenants/sentropic-remote/`).
- Kubeconfig fetché : `make -C ~/src/poc-k8s kubeconfig` → `~/.kube/poc.yaml`.

## Étape 1 : Rendre les images GHCR publiques (one-shot)

Au premier push, les images `ghcr.io/rhanka/sentropic-remote-{control-plane,session-agent}` sont **privées**. Deux options :

### Option A — Rendre publiques (recommandé pour POC)

Via UI :

- <https://github.com/users/rhanka/packages/container/sentropic-remote-control-plane/settings> → bas de page → **Change visibility** → Public
- pareil pour `sentropic-remote-session-agent`

Ou via API (nécessite `write:packages` scope, refresh token : `gh auth refresh -s write:packages`) :

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
# Patch ServiceAccount pour utiliser ce secret par défaut
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote patch sa sentropic-remote-control-plane \
  -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote patch sa default \
  -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
```

## Étape 2 : Déployer le control-plane

Depuis `~/src/remote/` :

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-deploy
# Optionnel : SCW_INGRESS=1 si tu as un DNS + cert-manager déjà installés
```

Le namespace `sentropic-remote` est déjà créé par `poc-k8s`. Le `make scw-deploy` réapplique son namespace (idempotent) puis RBAC + Deployment + Service.

## Étape 3 : Accéder au control-plane

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-port-forward
# Dans un autre shell :
curl http://localhost:8080/healthz
# {"ok":true,"service":"sentropic-remote-control-plane","protocolVersion":"0.1.0"}
remote codex --remote http://localhost:8080
```

Smoke automatisé live :

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-port-forward
# Dans un autre shell :
REMOTE_E2E_BASE_URL=http://localhost:8080 npm run test:e2e:live
```

## Étape 4 : Vérifier le quota et l'usage

```bash
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote describe resourcequota
kubectl --kubeconfig=~/.kube/poc.yaml -n sentropic-remote top pods   # nécessite metrics-server
```

## Cleanup

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-undeploy   # supprime le Deployment, garde le namespace + quotas (gérés par poc-k8s)
```

Le cluster reste up (~15€/mois). Pour tout démolir :

```bash
scw k8s cluster delete 979c11ad-9f84-4847-a334-c42a5e797976
```
