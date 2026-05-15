SHELL := /bin/bash

CLUSTER ?= sentropic-remote
NAMESPACE ?= sentropic-remote
CONTROL_PLANE_IMAGE ?= ghcr.io/rhanka/sentropic-remote-control-plane:v0.1.0
SESSION_AGENT_IMAGE ?= ghcr.io/rhanka/sentropic-remote-session-agent:v0.1.0
PORT ?= 8080

.PHONY: help install build typecheck test verify format format-write \
	images images-control-plane images-session-agent \
	k3d-up k3d-down k3d-load deploy undeploy port-forward wait-ready \
	demo demo-down \
	scw-deploy scw-undeploy scw-port-forward \
	scw-pause scw-resume scw-status \
	cli-build cli-link cli-unlink

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
	@echo "Scaleway Kapsule (export KUBECONFIG=~/.kube/poc.yaml first):"
	@echo "  scw-deploy           kubectl apply -f deploy/scw/ (add SCW_INGRESS=1 for the Ingress)"
	@echo "  scw-port-forward     expose the Kapsule control-plane locally on $(PORT)"
	@echo "  scw-pause            scale control-plane to 0 (autoscaler tears down the node ~10 min later)"
	@echo "  scw-resume           scale control-plane back to 1 (autoscaler brings a node back in 1-2 min)"
	@echo "  scw-status           show deploy, pods, nodes and remaining session Pods"
	@echo "  scw-undeploy         remove the Kapsule deployment (keeps the namespace + quota)"

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

# --- Scaleway Kapsule -----------------------------------------------------
# Apply deploy/scw/ on the cluster pointed to by $KUBECONFIG. Skips the
# optional Ingress manifest unless SCW_INGRESS=1 is set.
scw-deploy:
	kubectl apply -f deploy/scw/00-namespace.yaml
	kubectl apply -f deploy/scw/10-rbac.yaml
	kubectl apply -f deploy/scw/20-control-plane.yaml
	@if [ "$(SCW_INGRESS)" = "1" ]; then kubectl apply -f deploy/scw/30-ingress.yaml; fi
	kubectl -n $(NAMESPACE) rollout status deploy/control-plane --timeout=180s

scw-undeploy:
	-kubectl delete -f deploy/scw/30-ingress.yaml --ignore-not-found
	-kubectl delete -f deploy/scw/20-control-plane.yaml --ignore-not-found
	-kubectl delete -f deploy/scw/10-rbac.yaml --ignore-not-found
	-kubectl delete -f deploy/scw/00-namespace.yaml --ignore-not-found

scw-port-forward:
	kubectl -n $(NAMESPACE) port-forward svc/sentropic-remote-control-plane $(PORT):8080

# Pause: scale the workload to 0 so the cluster-autoscaler can evict the node.
# (Session Pods provisioned by the control-plane are NOT touched here; stop
# them first via `remote stop` if you want a clean zero. Otherwise an existing
# session Pod will keep the node alive.)
scw-pause:
	kubectl -n $(NAMESPACE) scale deploy/control-plane --replicas=0
	@SESSIONS=$$(kubectl -n $(NAMESPACE) get pods -l app.kubernetes.io/component=session-agent --no-headers 2>/dev/null | wc -l); \
	if [ "$$SESSIONS" -gt 0 ]; then \
	  echo "==> WARN: $$SESSIONS session-agent Pod(s) still running; stop them or the autoscaler will keep the node up."; \
	  kubectl -n $(NAMESPACE) get pods -l app.kubernetes.io/component=session-agent --no-headers; \
	else \
	  echo "==> control-plane scaled to 0. Autoscaler will evict the node within ~10 min (ScaleDownUnneededTime)."; \
	fi

scw-resume:
	kubectl -n $(NAMESPACE) scale deploy/control-plane --replicas=1
	kubectl -n $(NAMESPACE) rollout status deploy/control-plane --timeout=300s
	@echo "==> control-plane is back. /healthz reachable via 'make scw-port-forward'."

scw-status:
	@echo "=== Deployment ===" ; kubectl -n $(NAMESPACE) get deploy/control-plane -o wide 2>/dev/null || true
	@echo "" ; echo "=== Pods ($(NAMESPACE)) ===" ; kubectl -n $(NAMESPACE) get pods -o wide 2>/dev/null || true
	@echo "" ; echo "=== Nodes ===" ; kubectl get nodes -o wide 2>/dev/null || true

cli-build:
	corepack npm run -w @sentropic/remote-protocol build
	corepack npm run -w @sentropic/remote-cli build

cli-link: cli-build
	corepack npm link -w @sentropic/remote-cli
	@echo "==> 'remote' is now in PATH. Try: remote --help"

cli-unlink:
	corepack npm unlink -g @sentropic/remote-cli 2>/dev/null || true
