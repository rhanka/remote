# Intention -> spec traceability

Date: 2026-05-09

## Sources auditees

- Intention initiale brute: `docs/brief-as-is.md`
- Addition MVP/V2: `docs/brief-additions/2026-05-09-mvp-v2-os.md`
- Spec issue du brainstorm: `docs/superpowers/specs/2026-05-09-remote-controle-mvp-design.md`
- Decision nommage/package: `docs/decisions/2026-05-10-naming-and-packaging.md`

Commits GitHub connus:

- Intention initiale brute: `b0e60a73603c61f7304422c21e2028f1dc85f22f`
- Addition MVP/V2: `fdb13e42b90674e88c07f4b9cb8bfb8d70e2f0a3`
- Spec MVP: `0c73361886c01b277bade710b8d86372c6cc54a0`

## Mapping intention -> spec

### 1. Piloter n'importe quelle CLI avec n'importe quelle CLI

Intention:

> Piloter n'importe quelle CLI avec n'importe quelle CLI, pour code ou autre tache.

Spec:

- Sections: `Goals`, `Master And Slave Plugins`, `Session Runtime`.
- Traduction: sessions commandables par plugin maitre, frontend operateur, ou API.

### 2. Backend minimal d'orchestration

Intention:

> Backend minimal pour orchestration de sessions a la demande en micro-conteneurs isoles.

Spec:

- Control plane TypeScript k8s-native.
- Creation directe de ressources Kubernetes:
  - `Pod`
  - `PVC`
  - `Service`
  - `Secret`
  - `ConfigMap`
- Pas de CRD/operator au MVP.

### 3. Cibles Kubernetes

Intention:

> k8s sur Scaleway ou GCP.

Spec:

- Ordre cible valide:
  - `k3s` pour developpement cluster realiste.
  - Scaleway Kapsule PoC.
  - GKE.

### 4. Workspace persistant

Intention:

> Filesystem virtuel persistant pour les sessions de code.

Spec:

- `PVC` par session.
- Montage dans `/workspace`.
- Persistance entre redemarrages/reconnexions.

### 5. Secrets

Intention:

> Orchestration avec le systeme de secret.

Spec:

- Secrets longs hors runtime de session.
- Injection temporaire par session.
- Policies par capability.
- Aucun secret long stocke dans l'historique de conversation.

### 6. CLIs disponibles

Intention:

> Ensemble des CLI dispo: codex/opencode/claude-code/gemini-cli, gh, scw, gcloud, npm, python.

Spec:

- Profils CLI initiaux:
  - `shell`
  - `codex`
  - `opencode`
  - `claude-code`
  - `gemini-cli`
- Runtime image controlee avec outils ops/dev.
- Secrets et approvals pour `gh`, `scw`, `gcloud`, `npm`, `python`, etc.

### 7. Tests par session

Intention:

> Pop des docker/tests de chaque session.

Spec:

- Scenario MVP:
  - installer les dependances;
  - executer tests/build;
  - exposer une UAT;
  - conserver les artefacts.
- Extension future: containers de test dedies par session.

### 8. Navigateur delegue

Intention:

> Navigateur headed pour action de navigation en delegation de l'utilisateur.

Spec:

- Runtime Playwright headed.
- Browser bridge.
- Panes UAT/browser integres au frontend.
- WebRTC quand la latence d'interaction l'exige.

### 9. Config et historique de session

Intention:

> Gestion des confs de session et stockage perenne des conversations de session.

Spec:

- Profils de session.
- Historique conversation/evenements.
- Workspace persistant.
- Event log append-only pour les decisions sensibles.

### 10. Plugin maitre

Intention:

> Plugin pour une session maitre: instructions, drumbeat, avancement, escalades,
> planifier/configurer/poper nouveaux envs.

Spec:

- Section: `Master And Slave Plugins`.
- Master control:
  - instruction input;
  - drumbeat configurable;
  - status sessions;
  - approvals;
  - creation d'environnements depuis profils.

### 11. Plugin esclave

Intention:

> Plugin pour sessions esclaves: escalation sudo/install, validation, besoin 2FA.

Spec:

- `session-agent` / slave plugin.
- Capability requests:
  - secrets;
  - escalades;
  - 2FA;
  - actions navigateur sensibles.

### 12. Gestion 2FA

Intention:

> Gestionnaire de 2FA pour acceder aux secrets et/ou permettre la tierce auth 2FA.

Spec:

- 2FA par saisie utilisateur dans le frontend.
- Ou prise de main temporaire du navigateur par l'utilisateur.
- Jamais de secret 2FA durable donne a l'agent.

### 13. Frontend operateur

Intention:

> Terminal mobile swipe/tab par env, proxy UAT, proxy navigateur Playwright,
> voix via voxtral-js.

Spec:

- Svelte 5 frontend.
- Tabs desktop + swipe mobile.
- xterm.js.
- Panes UAT/browser.
- WebRTC si latence critique.
- Transcription live `voxtral-js` dans l'input CLI/instruction.

### 14. Veille et libs maitrisables

Intention:

> Veille des features cle remote control et libs a recoder si besoin,
> sans dependances opaques pour le coeur.

Spec:

- V2 research et core packages separes.
- Inspirations identifiees:
  - Coder
  - DevPod
  - OpenHands
  - WebContainers
  - SES/Endo
  - WASI
- Les fonctions coeur restent dans des packages maitrisables.

### 15. Stack technique

Intention:

> TypeScript backend et Svelte 5 frontend.

Spec:

- Backend TypeScript.
- Frontend Svelte 5.
- Monorepo avec packages publiables.

### 16. Publication librairies

Intention:

> Scaffolder pour publier un maximum en librairies, possiblement `@sentropic/...`.

Spec:

- Monorepo avec packages publiables potentiels.
- Scope npm retenu: `@sentropic`.
- Famille de packages cible: `@sentropic/remote-*`.

### 17. MVP end-to-end complet

Intention:

> MVP doit couvrir code + ops CLI + navigateur/2FA, sinon pas de test bout en bout.

Spec:

- Sections: `Context`, `Testing Strategy`.
- Un E2E unique doit couvrir:
  - code;
  - ops CLI;
  - navigateur/UAT;
  - 2FA/approval;
  - persistance.

### 18. V2 micro-OS TypeScript

Intention:

> Emulateur d'OS TypeScript dans V8 pour paravirtualisation plus micro.

Spec:

- Section: `V2 Research: TypeScript Micro-OS`.
- Gates A-D.
- Menu initial de commandes.
- Verification Codex/Claude Code dans containers k8s reels avant hypothese micro-OS.

## Decisions prises pendant brainstorm

- MVP = tranche verticale complete: code + ops CLI + navigateur/2FA.
- Orchestration = k8s-native des le depart.
- Implementation MVP = backend TS qui cree directement les objets k8s, pas operator/CRD au premier plan.
- Cibles = k3s, puis Scaleway Kapsule PoC, puis GKE.
- Secrets/approvals = decisions `1B / 2B / 3B / 4A+B / 5B`:
  - secrets longs hors session, injection temporaire;
  - demande explicite de secret pendant la session;
  - policy par capability;
  - 2FA par saisie utilisateur ou prise de main navigateur;
  - audit append-only structure.
- Frontend = `B` partout, avec nuance voix `B+C`:
  - tabs desktop + swipe mobile;
  - terminal + side panel approvals/events;
  - panes integres terminal/UAT/browser;
  - WebRTC lorsque la latence navigateur l'exige;
  - transcription live `voxtral-js` dans l'input CLI/instruction;
  - master control instruction + drumbeat + status + approvals.
- Packaging = `B/C/B/B`:
  - monorepo publiable;
  - scope npm differe;
  - packages coeur des le depart;
  - interfaces reservees pour V2 micro-OS.
- V2 = etude dediee et gates de faisabilite, notamment verifier Codex et Claude Code dans des containers k8s reels avant d'imaginer les lancer dans un micro-OS TS.

## Exclusions volontaires du MVP

- Pas de runtime produit local hors k8s. k3s est accepte parce que c'est Kubernetes.
- Pas de promesse multi-tenant hostile au MVP.
- Pas de CRD/operator au MVP, mais contrats prepares pour migration.
- Pas d'implementation micro-OS TS au MVP; seulement interfaces reservees et plan de recherche.

## Points ouverts a trancher avant implementation detaillee

- Acces de publication npm au scope `@sentropic` depuis ce repository.
- Namespace par session ou namespace partage avec labels stricts.
- Premiere source externe de secrets pour k3s et Scaleway PoC.
- Browser transport initial: WebRTC-first ou fallback noVNC/WebSocket avec spike WebRTC.
