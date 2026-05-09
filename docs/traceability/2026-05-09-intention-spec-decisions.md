# Intention -> spec traceability

Date: 2026-05-09

## Sources auditees

- Intention initiale brute: `docs/brief-as-is.md`
- Addition MVP/V2: `docs/brief-additions/2026-05-09-mvp-v2-os.md`
- Spec issue du brainstorm: `docs/superpowers/specs/2026-05-09-remote-controle-mvp-design.md`

Commits GitHub connus:

- Intention initiale brute: `b0e60a73603c61f7304422c21e2028f1dc85f22f`
- Addition MVP/V2: `fdb13e42b90674e88c07f4b9cb8bfb8d70e2f0a3`
- Spec MVP: `0c73361886c01b277bade710b8d86372c6cc54a0`

## Mapping intention -> spec

| Intention utilisateur | Traduction dans la spec |
| --- | --- |
| Piloter n'importe quelle CLI avec n'importe quelle CLI, pour code ou autre tache | `Goals`, `Master And Slave Plugins`, `Session Runtime` |
| Backend minimal d'orchestration de sessions a la demande en micro-conteneurs isoles | Control plane TypeScript k8s-native qui cree directement `Pod`, `PVC`, `Service`, `Secret`, `ConfigMap`; pas de CRD/operator au MVP |
| k8s sur Scaleway ou GCP | Ordre cible valide: `k3s` pour dev cluster, Scaleway Kapsule PoC, puis GKE |
| Filesystem virtuel persistant pour sessions de code | `PVC` par session monte dans `/workspace` |
| Orchestration avec systeme de secrets | Secrets longs hors runtime; injection temporaire par session; policies par capability |
| Ensemble des CLI disponibles: codex/opencode/claude-code/gemini-cli, gh, scw, gcloud, npm, python | Profils CLI initiaux et runtime image controlee; secrets/approvals pour outils ops |
| Pop des docker/tests de chaque session | Scenario MVP: install/test/build dans workspace, avec extension future vers containers de test par session |
| Navigateur headed pour delegation utilisateur | Runtime Playwright headed + browser bridge + UAT/browser panes dans le frontend |
| Configs de session et stockage perenne conversations | Profils de session, historique conversation/evenements, workspace persistant |
| Plugin session maitre: instructions, drumbeat, avancement, escalades, planifier/configurer/poper nouveaux envs | `Master And Slave Plugins`; master control avec instruction input, drumbeat, status et approvals |
| Plugin sessions esclaves: escalade sudo/install, validation, besoin 2FA | `session-agent` / slave plugin avec capability requests, approvals, 2FA |
| Gestionnaire 2FA pour secrets et auth tierce | 2FA par saisie utilisateur et/ou prise de main temporaire navigateur; jamais de secret 2FA durable donne a l'agent |
| Frontend terminal mobile swipe/tab par env, proxy UAT, proxy navigateur Playwright, voix via voxtral-js | Svelte 5 frontend, tabs desktop + swipe mobile, xterm.js, panes UAT/browser, WebRTC si latence critique, transcription live `voxtral-js` |
| Veille des features cle remote control et libs a recoder si besoin, sans dependances opaques pour le coeur | Spec garde V2 research et core packages; inspiration Coder/DevPod/OpenHands/WebContainers/SES/WASI, sans copier les fonctions coeur |
| TypeScript backend et Svelte 5 frontend | `Goals`, `Frontend Operator` |
| Scaffolder pour publier un maximum en librairies, possiblement `@entropic/...` | Monorepo avec packages publiaux potentiels; scope npm differe, compatible `@entropic/...` si acces confirme |
| MVP doit couvrir code + ops CLI + navigateur/2FA, sinon pas de test bout en bout | `Context`, `Testing Strategy`: un E2E unique doit couvrir les 3 familles |
| V2: emulateur d'OS TypeScript dans V8 pour paravirtualisation plus micro | `V2 Research: TypeScript Micro-OS`, gates A-D, menu initial de commandes |

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

- Repository ou organisation qui publie deja sous `@entropic/...` et acces au scope.
- Namespace par session ou namespace partage avec labels stricts.
- Premiere source externe de secrets pour k3s et Scaleway PoC.
- Browser transport initial: WebRTC-first ou fallback noVNC/WebSocket avec spike WebRTC.
