# Scaleway Kapsule deployment

Manifests overlay for Sentropic Remote on a Scaleway Kapsule cluster.

## Differences vs `deploy/k3s/`

- `imagePullPolicy: Always` — Kapsule pulls from GHCR every roll, no local image import.
- `SESSION_STORAGE_CLASS=scw-bssd` env so the control-plane provisions PVCs
  with Scaleway's Block Storage (the default `scw-bssd` storage class is
  pre-installed on Kapsule, ReadWriteOnce SSD-backed).
- Resource requests/limits sized for a real workload (100m/128Mi -> 500m/512Mi).
- Optional `30-ingress.yaml` Traefik Ingress with cert-manager TLS.

## Prerequisites

1. **Kapsule cluster created** (Scaleway console or `scw k8s cluster create`).
2. **kubeconfig fetched**: `scw k8s kubeconfig get <cluster-id> > ~/.kube/scw.yaml && export KUBECONFIG=~/.kube/scw.yaml`.
3. **Images pushed to GHCR** at the tags referenced in `20-control-plane.yaml`
   and the `SESSION_AGENT_IMAGE` env (see `.github/workflows/build-and-push.yml`
   for the release pipeline; you can also push manually:
   `docker login ghcr.io && docker push ghcr.io/sentropic/remote-control-plane:0.1.0`
   and the session-agent image).
4. **cert-manager + ClusterIssuer `letsencrypt`** if you want HTTPS via the
   Ingress; otherwise drop `30-ingress.yaml`.

## Deploy

```bash
export KUBECONFIG=~/.kube/scw.yaml
kubectl apply -f deploy/scw/00-namespace.yaml
kubectl apply -f deploy/scw/10-rbac.yaml
kubectl apply -f deploy/scw/20-control-plane.yaml
kubectl apply -f deploy/scw/30-ingress.yaml  # optional
kubectl -n sentropic-remote rollout status deploy/control-plane --timeout=180s
```

## Usage from your laptop

If you exposed Ingress on `remote.sentropic.dev` :

```bash
remote codex --remote https://remote.sentropic.dev
```

Otherwise port-forward the Service through your laptop :

```bash
kubectl -n sentropic-remote port-forward svc/sentropic-remote-control-plane 8080:8080
remote codex --remote http://localhost:8080
```

The CLI bundles your local `~/.codex/auth.json` (and equivalents for claude /
gemini) as a per-session K8s Secret mounted readonly in the Pod, so the agent
CLI starts already logged in.

## Image tags and rollouts

The release workflow tags both images on every git tag matching `v*` :

- `ghcr.io/sentropic/remote-control-plane:<tag>` and `:latest`
- `ghcr.io/sentropic/remote-session-agent:<tag>` and `:latest`

Update the `image:` and `SESSION_AGENT_IMAGE` values in
`20-control-plane.yaml` to bump versions on Kapsule.

## Cleanup

```bash
kubectl delete -f deploy/scw/30-ingress.yaml --ignore-not-found
kubectl delete -f deploy/scw/20-control-plane.yaml --ignore-not-found
kubectl delete -f deploy/scw/10-rbac.yaml --ignore-not-found
kubectl delete -f deploy/scw/00-namespace.yaml --ignore-not-found
```
