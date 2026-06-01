# Scaleway Kapsule deployment (tenant)

This directory ships **only the tenant-owned manifests** for the
`sentropic-remote` workload on a shared Scaleway Kapsule cluster:

- `10-rbac.yaml` — ServiceAccount + Role + RoleBinding (namespace-scoped, so
  the control-plane Pod can create/delete Pods, PVCs and Secrets for sessions
  _inside its namespace only_).
- `20-control-plane.yaml` — Deployment + ClusterIP Service for the
  control-plane.
- `30-ingress.yaml` — optional Traefik Ingress (apply with `SCW_INGRESS=1`).

The **namespace, ResourceQuota, LimitRange and NetworkPolicy baseline** are
owned by the cluster operator and live in
[`poc-k8s/tenants/sentropic-remote/`](https://github.com/rhanka/poc-k8s/tree/main/tenants/sentropic-remote).
Apply them first; this Makefile won't touch them.

## Differences vs `deploy/k3s/`

- `imagePullPolicy: Always` so Kapsule pulls from GHCR every rollout.
- The SCW POC manifest tracks the GHCR `:main` images so urgent migration
  fixes can be deployed immediately after the main-branch image workflow
  finishes. Pin a release tag again once the migration POC is stable.
- `SESSION_STORAGE_CLASS=matchid-rwx` +
  `SESSION_STORAGE_ACCESS_MODE=ReadWriteMany` env (Scaleway File Storage CSI,
  via the shared `poc-k8s` StorageClass).
- `SESSION_WORKSPACE_SIZE=100G`, because Scaleway File Storage rejects smaller
  PVC requests and requires decimal-gigabyte sizing.
- `SESSION_NODE_SELECTOR=k8s.scaleway.com/pool-name=burst-rwx` so session Pods
  land on the POP2 burst pool required by File Storage CSI. The older `burst`
  pool can be DEV1-XL on existing clusters and is not sufficient for RWX.
- Resource requests/limits sized for a real workload (100m/128Mi → 500m/512Mi).
- Optional Ingress via Traefik + cert-manager Let's Encrypt.

## Prerequisites (cluster operator-side, in `~/src/poc-k8s/`)

```bash
make kubeconfig                     # ~/.kube/poc.yaml
make filestorage-csi-enable apply-platform apply-sentropic-remote
make filestorage-csi-status         # confirms filestorage.csi.scaleway.com + matchid-rwx
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

For bulk migration of local projects into open-but-detached remote sessions,
run from each real project directory:

```bash
remote migrate forward codex --resume --no-attach
remote ls
```

The command links/reuses that project's workspace, pushes git-tracked files to
the RWX PVC, creates the remote session, and prints the attach command to use
when reconnecting a local terminal.

The CLI bundles your local `~/.codex/auth.json` (and equivalents for claude /
antigravity) as a per-session K8s Secret mounted readonly in the Pod, so the
agent CLI starts already logged in.

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
