# Scaleway Kapsule deployment (tenant)

This directory ships **only the tenant-owned manifests** for the
`sentropic-remote` workload on a shared Scaleway Kapsule cluster:

- `10-rbac.yaml` — ServiceAccount + Role + RoleBinding (namespace-scoped, so
  the control-plane Pod can create/delete Pods, PVCs and Secrets for sessions
  *inside its namespace only*).
- `20-control-plane.yaml` — Deployment + ClusterIP Service for the
  control-plane.
- `30-ingress.yaml` — optional Traefik Ingress (apply with `SCW_INGRESS=1`).

The **namespace, ResourceQuota, LimitRange and NetworkPolicy baseline** are
owned by the cluster operator and live in
[`poc-k8s/tenants/sentropic-remote/`](https://github.com/rhanka/poc-k8s/tree/main/tenants/sentropic-remote).
Apply them first; this Makefile won't touch them.

## Differences vs `deploy/k3s/`

- `imagePullPolicy: Always` so Kapsule pulls from GHCR every rollout.
- `SESSION_STORAGE_CLASS=scw-bssd` env (Scaleway Block Storage, ReadWriteOnce).
- Resource requests/limits sized for a real workload (100m/128Mi → 500m/512Mi).
- Optional Ingress via Traefik + cert-manager Let's Encrypt.

## Prerequisites (cluster operator-side, in `~/src/poc-k8s/`)

```bash
make kubeconfig                     # ~/.kube/poc.yaml
make apply-platform apply-sentropic-remote
```

## Deploy this tenant

From `~/src/remote/` :

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-deploy             # RBAC + Deployment + Service
KUBECONFIG=~/.kube/poc.yaml make scw-deploy SCW_INGRESS=1  # + the Ingress
```

`make scw-deploy` does not create the namespace; that's the cluster operator's
job (see `poc-k8s/tenants/sentropic-remote/`).

## Usage from your laptop

Either through Ingress (DNS) :

```bash
remote codex --remote https://remote.sentropic.dev
```

…or via port-forward (delegated to `poc-k8s`'s `tenant-port-forward` helper) :

```bash
make -C ../poc-k8s tenant-port-forward \
  TENANT=sentropic-remote SVC=sentropic-remote-control-plane PORT=8080
remote codex --remote http://localhost:8080
```

The CLI bundles your local `~/.codex/auth.json` (and equivalents for claude /
gemini) as a per-session K8s Secret mounted readonly in the Pod, so the agent
CLI starts already logged in.

## Pause / resume the workload

This is delegated to `poc-k8s` so the cluster operator stays the source of
truth for node-level lifecycle (autoscaler-driven scale-to-zero) :

```bash
make -C ../poc-k8s tenant-pause  TENANT=sentropic-remote DEPLOY=control-plane
make -C ../poc-k8s tenant-resume TENANT=sentropic-remote DEPLOY=control-plane
```

## Image tags and rollouts

The release workflow tags both images on every git tag matching `v*` :

- `ghcr.io/rhanka/sentropic-remote-control-plane:<tag>` and `:latest`
- `ghcr.io/rhanka/sentropic-remote-session-agent:<tag>` and `:latest`

Update the `image:` and `SESSION_AGENT_IMAGE` values in
`20-control-plane.yaml` to bump versions on Kapsule.

## Cleanup (tenant workload only — namespace + quota stay)

```bash
KUBECONFIG=~/.kube/poc.yaml make scw-undeploy
```
