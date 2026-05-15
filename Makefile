SHELL := /bin/bash

CLUSTER ?= sentropic-remote
NAMESPACE ?= sentropic-remote
CONTROL_PLANE_IMAGE ?= ghcr.io/sentropic/remote-control-plane:0.1.0
SESSION_AGENT_IMAGE ?= ghcr.io/sentropic/remote-session-agent:0.1.0
PORT ?= 8080

.PHONY: help install build typecheck test verify format format-write \
	images images-control-plane images-session-agent \
	k3d-up k3d-down k3d-load deploy undeploy port-forward

help:
	@echo "Targets:"
	@echo "  install              npm install (workspaces)"
	@echo "  build / typecheck / test / verify / format / format-write"
	@echo "  images               build both docker images"
	@echo "  k3d-up               create the local k3d cluster ($(CLUSTER))"
	@echo "  k3d-load             import images into the k3d cluster"
	@echo "  deploy               apply deploy/k3s manifests"
	@echo "  port-forward         expose the control-plane on http://localhost:$(PORT)"
	@echo "  undeploy / k3d-down  cleanup"

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
