# Local k3s / k3d deployment

Minimal manifests to run Sentropic Remote on a local Kubernetes cluster.

## Layout

- `00-namespace.yaml` — `sentropic-remote` namespace.
- `10-rbac.yaml` — `ServiceAccount`, `Role`, `RoleBinding` granting the control-plane the verbs needed to provision session Pods + PVCs (and read pod logs/exec).
- `20-control-plane.yaml` — `Deployment` (image `ghcr.io/rhanka/sentropic-remote-control-plane:v0.1.0`, liveness/readiness on `/healthz`) + `ClusterIP` Service `sentropic-remote-control-plane` on port 8080. The session-agent images are pulled by the control-plane on demand when a session is created.

## Quickstart (k3d)

```bash
make k3d-up
make images
make k3d-load
make deploy
make port-forward
```

Then in another shell:

```bash
curl http://localhost:8080/healthz
curl -X POST http://localhost:8080/sessions \
  -H 'content-type: application/json' \
  -d '{"profile":"codex","target":"k3s"}'
```

The control-plane creates a Pod + PVC per session in the `sentropic-remote` namespace; `kubectl -n sentropic-remote get pods` should show the new session pod, and `kubectl logs` streams the agent stdio.

## Cleanup

```bash
make undeploy
make k3d-down
```
