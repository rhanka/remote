SHELL := /bin/bash

CLUSTER ?= sentropic-remote
NAMESPACE ?= sentropic-remote
CONTROL_PLANE_IMAGE ?= ghcr.io/rhanka/sentropic-remote-control-plane:v0.5.5
SESSION_AGENT_IMAGE ?= ghcr.io/rhanka/sentropic-remote-session-agent:v0.5.5
PORT ?= 8080

.PHONY: help install build typecheck test verify format format-write \
	images images-control-plane images-session-agent \
	k3d-up k3d-down k3d-load deploy undeploy port-forward wait-ready \
	demo demo-down \
	scw-deploy scw-undeploy scw-port-forward scw-prepull \
	cli-build cli-link cli-unlink \
	e2e-docker e2e-k3s e2e-isolation

help:
	@echo "One-shot:"
	@echo "  make demo            cluster + images + deploy + wait-ready (then run 'make port-forward' separately)"
	@echo "  make demo-down       tear it all down (deploy + cluster)"
	@echo ""
	@echo "Steps:"
	@echo "  install              npm install (workspaces)"
	@echo "  build / typecheck / test / verify / format / format-write"
	@echo "  cli-build            build @sentropic/remote-cli"
	@echo "  cli-link             install 'remote' into \$$PATH via npm link"
	@echo "  cli-unlink           remove the 'remote' link"
	@echo "  images               build both docker images"
	@echo "  k3d-up               create the local k3d cluster ($(CLUSTER))"
	@echo "  k3d-load             import images into the k3d cluster"
	@echo "  deploy               apply deploy/k3s manifests"
	@echo "  wait-ready           wait for the control-plane Deployment rollout"
	@echo "  port-forward         expose the control-plane on http://localhost:$(PORT)"
	@echo "  undeploy / k3d-down  individual cleanup"
	@echo ""
	@echo "Scaleway Kapsule (tenant-only; cluster + namespace owned by ../poc-k8s):"
	@echo "  scw-deploy           apply RBAC + Deployment + Service + pre-pull DaemonSet (add SCW_INGRESS=1 for the Ingress)"
	@echo "  scw-prepull          re-pull session-agent:main on all session nodes (run after a release)"
	@echo "  scw-port-forward     expose the Kapsule control-plane locally on $(PORT)"
	@echo "  scw-undeploy         remove the Kapsule workload (namespace + quota stay, owned by poc-k8s)"
	@echo "  (cluster ops — pause/resume node, autoscaler, kubeconfig — live in ../poc-k8s/Makefile)"

install:
	corepack npm install

build:
	corepack npm run build

typecheck:
	corepack npm run typecheck

test:
	corepack npm run test

verify:
	corepack npm run verify

format:
	corepack npm run format

format-write:
	corepack npm run format:write

images: images-control-plane images-session-agent

images-control-plane:
	docker build -t $(CONTROL_PLANE_IMAGE) -f apps/control-plane/Dockerfile .

images-session-agent:
	docker build -t $(SESSION_AGENT_IMAGE) -f packages/session-agent/Dockerfile .

k3d-up:
	k3d cluster list | grep -q "^$(CLUSTER)\b" || k3d cluster create $(CLUSTER) --wait

k3d-down:
	k3d cluster delete $(CLUSTER)

k3d-load: images
	k3d image import $(CONTROL_PLANE_IMAGE) $(SESSION_AGENT_IMAGE) -c $(CLUSTER)

deploy:
	kubectl apply -f deploy/k3s/

undeploy:
	kubectl delete -n $(NAMESPACE) deployment/control-plane svc/sentropic-remote-control-plane --ignore-not-found
	kubectl delete -f deploy/k3s/ --ignore-not-found

port-forward:
	kubectl -n $(NAMESPACE) port-forward svc/sentropic-remote-control-plane $(PORT):8080

wait-ready:
	kubectl -n $(NAMESPACE) rollout status deploy/control-plane --timeout=180s

demo: k3d-up k3d-load deploy wait-ready
	@echo ""
	@echo "==> Cluster $(CLUSTER) is ready with control-plane deployed."
	@echo "    Run 'make port-forward' in another shell, then:"
	@echo "      curl http://localhost:$(PORT)/healthz"
	@echo "      curl -X POST http://localhost:$(PORT)/sessions \\"
	@echo "        -H 'content-type: application/json' \\"
	@echo "        -d '{\"profile\":\"codex\",\"target\":\"k3s\"}'"

demo-down: undeploy k3d-down

# --- End-to-end session smoke (two backends) ------------------------------
# e2e-docker: in-process control-plane + DockerSessionProvisioner (no k8s).
# e2e-k3s:    full k3d cluster (make demo) + port-forward.
e2e-docker: build images-session-agent
	bash e2e/run-docker.sh

# e2e-isolation: docker backend + bearer auth; asserts per-user namespace isolation.
e2e-isolation: build images-session-agent
	bash e2e/run-isolation.sh

e2e-k3s: demo
	bash e2e/run-k3s.sh

# --- Scaleway Kapsule (tenant-scoped) -------------------------------------
# This Makefile deploys the sentropic-remote workload INTO an existing
# namespace owned by the cluster operator (cf. ../poc-k8s/tenants/
# sentropic-remote/). The namespace + ResourceQuota + LimitRange +
# NetworkPolicy baseline are NOT applied here; they belong to poc-k8s.
# Cluster lifecycle (pool autoscale, kubeconfig, pause/resume, node ops)
# is also out of scope for this Makefile.
#
# Run `make -C ../poc-k8s apply-sentropic-remote` first to ensure the
# namespace + quotas are live, then `make scw-deploy` here.
scw-deploy:
	kubectl apply -f deploy/scw/10-rbac.yaml
	kubectl apply -f deploy/scw/20-control-plane.yaml
	@if [ "$(SCW_INGRESS)" = "1" ]; then kubectl apply -f deploy/scw/30-ingress.yaml; fi
	kubectl apply -f deploy/scw/40-prepull.yaml
	kubectl -n $(NAMESPACE) rollout status deploy/control-plane --timeout=180s

# session-agent:main moved (CI retags on every push to main) but the prepull
# pods only pull at (re)creation — restart them to refresh the node caches.
scw-prepull:
	kubectl -n $(NAMESPACE) rollout restart daemonset/session-agent-prepull

scw-undeploy:
	-kubectl delete -f deploy/scw/40-prepull.yaml --ignore-not-found
	-kubectl delete -f deploy/scw/30-ingress.yaml --ignore-not-found
	-kubectl delete -f deploy/scw/20-control-plane.yaml --ignore-not-found
	-kubectl delete -f deploy/scw/10-rbac.yaml --ignore-not-found

scw-port-forward:
	kubectl -n $(NAMESPACE) port-forward svc/sentropic-remote-control-plane $(PORT):8080

cli-build:
	corepack npm run -w @sentropic/remote-protocol build
	corepack npm run -w @sentropic/remote-cli build

cli-link: cli-build
	corepack npm link -w @sentropic/remote-cli
	@echo "==> 'remote' is now in PATH. Try: remote --help"

cli-unlink:
	corepack npm unlink -g @sentropic/remote-cli 2>/dev/null || true
