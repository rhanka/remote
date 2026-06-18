# Spec Study — WP16 llm-mesh teamclaude account pool

Statut : **STUDY / demarrage WP16** — 2026-06-17.
Track : `WP16` `01KVB6HKZH7D4TFVYDZTRY70PJ`, slice 0
`01KVB6JTB6V82W78BG2R1FHXG3`.

Finalite a rappeler a chaque passe : **un pour tous, tous pour un**.
L'utilisateur doit pouvoir cumuler des comptes Claude et Codex, lancer une
session depuis la CLI Claude ou Codex, et beneficier du pool sans changer son
workflow de base, tout en gardant la continuite d'une session sur le meme
compte.

## 1. Intention brute

Ajouter dans `remote` une fonction de type `../teamclaude`, basee sur la version
cible `llm-mesh@0.4.0`, pour mutualiser plusieurs comptes Claude et Codex.

Contraintes utilisateur non negociables :

- **Un pour tous, tous pour un** : les comptes disponibles forment un pool utile
  aux sessions Claude et Codex.
- Une session existante reste **sticky** sur le meme compte jusqu'a sa fin ou
  une action explicite. Pas d'alternance de compte au milieu d'une conversation.
- Les nouvelles sessions peuvent alterner entre 2 ou 3 comptes Claude, et aussi
  utiliser des comptes Codex quand le routage le permet.
- La surface doit marcher que l'agent courant soit `claude` ou `codex`.
- `remote` doit gerer les pieces operationnelles : config, secrets, propagation
  locale/remote, diagnostic, fallback, et audit minimal.

## 2. Evidence locale deja lue

- `../teamclaude/spec/SPEC_EVOL_LLM_MESH_CODEX.md` decrit un proxy
  `/v1/messages` qui preserve le chemin Anthropic existant et route les comptes
  Codex via `@sentropic/llm-mesh`.
- `../teamclaude/src/llm-mesh.js` contient deja la traduction
  Anthropic Messages -> OpenAI/Codex Responses, le streaming et la conversion
  d'outils.
- `../teamclaude/test/llm-mesh.test.js` couvre notamment l'exclusion des comptes
  Codex de la selection active et les conversions Anthropic/Codex.
- Le checkout local `../sentropic/packages/llm-mesh` est en `0.2.0`, pas
  `0.4.0`. Le support Claude Code annonce pour `0.4.0` doit donc etre verifie
  ou ramene dans l'environnement avant implementation.

## 3. These de depart

WP16 ne doit pas etre seulement un proxy HTTP. C'est un **service de routage par
session** :

1. `llm-mesh` porte la frontiere provider/auth et les conversions.
2. `remote` porte l'identite de session, la selection de compte, le sticky
   binding, les secrets et la propagation dans les pods.
3. Le proxy expose une surface compatible avec les CLI existantes, sans forcer
   l'utilisateur a savoir quel compte a ete choisi.

## 4. Architecture candidate

### 4.1 Registry de comptes

Un registre local par utilisateur decrit les comptes sans exposer les secrets :

```json
{
  "accounts": [
    { "id": "claude-a", "provider": "claude-code", "label": "Claude A" },
    { "id": "claude-b", "provider": "claude-code", "label": "Claude B" },
    { "id": "codex-a", "provider": "codex", "label": "Codex A" }
  ]
}
```

Les secrets restent hors `track` et hors logs. La forme exacte depend de
`llm-mesh@0.4.0` : OAuth Claude Code, API key Anthropic, compte Codex, ou
transport generique `account-transport`.

### 4.2 Binding sticky par session

Au lancement d'une session, `remote` choisit un compte et persiste :

```json
{
  "sessionId": "sess-...",
  "profile": "claude",
  "accountId": "claude-b",
  "bindingReason": "round-robin",
  "createdAt": "..."
}
```

Ce binding doit survivre a `refresh`, `restore`, reconnexion control-plane et
relaunch. L'alternance ne vaut que pour les nouvelles sessions. Un `--account`
ou equivalent pourra forcer un compte explicite.

### 4.3 Proxy

Le proxy doit au minimum couvrir le chemin Claude Code compatible
`POST /v1/messages`, comme `teamclaude`, puis etendre selon les besoins reels
des CLI.

Deux emplacements restent a trancher :

- **Local first** : proxy local dans le laptop, les sessions locales et remote
  pointent vers lui quand le tunnel est present.
- **Pod/control-plane first** : proxy par utilisateur dans l'infra remote, les
  pods pointent vers une URL stable.

Le choix impacte directement la durabilite quand le laptop dort, la surface des
secrets, et la latence.

### 4.4 Integration remote

Pieces probables dans `remote` :

- commande d'installation/configuration du pool (`remote llm-mesh ...` ou nom a
  decider) ;
- selection de compte au lancement `remote claude|codex`, `remote run`, et
  `remote delegate` ;
- injection d'URL proxy/env dans les sessions ;
- diagnostic `remote ... status` : compte bind, proxy reachable, provider,
  dernier fallback, sans secret ;
- propagation pod via le modele existant creds/plugins/manifest ;
- garde anti-fuite : redaction systematique des tokens et fichiers secrets.

## 5. Decisions ouvertes

- **D1 — Nom et surface CLI.** `remote teamclaude`, `remote mesh`,
  `remote account-pool`, ou une sous-commande plus neutre ?
- **D2 — Emplacement du proxy.** Local, pod-side, control-plane, ou hybride ?
- **D3 — Source de verite des secrets.** Reutiliser les bundles auth existants,
  un store dedie, ou la config `llm-mesh` ?
- **D4 — Algorithme de selection.** Round-robin simple, least-recently-used,
  quota/rate-limit aware, ou manuel d'abord ?
- **D5 — Contrat `llm-mesh@0.4.0`.** Confirmer l'API executable Claude Code et
  la forme des account transports avant tout code.
- **D6 — Compat Codex depuis Claude et Claude depuis Codex.** Le proxy doit-il
  traduire toutes les formes d'appels ou seulement les appels Anthropic
  `/v1/messages` dans la premiere slice ?

## 6. Premiere slice proposee

Slice 0 reste un cadrage verifiable :

1. Verifier/ramener `llm-mesh@0.4.0` et documenter le contrat Claude Code.
2. Comparer `../teamclaude` avec les besoins `remote` : ce qui se copie, ce qui
   devient un package, ce qui reste specifique.
3. Produire un planner pur de binding de compte : entrees comptes + sessions,
   sortie `{session -> account}` sticky, sans secret.
4. Ajouter un diagnostic dry-run : "quelle session utiliserait quel compte et
   pourquoi".

La premiere implementation ne doit pas encore pousser de secrets dans des pods
ni modifier le comportement de sessions existantes sans opt-in.

## 7. Risques

- **Perte de continuite** si le compte change pendant une session : interdit par
  design, teste par binding sticky.
- **Fuite de tokens** via logs, track, diagnostics ou manifests : redaction et
  separation descriptor/secret obligatoires.
- **Proxy local indisponible** pour les sessions remote quand le laptop dort :
  decision D2 a traiter avant remote generalise.
- **Traduction incomplete tool/SSE** entre Anthropic et Codex : reprendre les
  tests `teamclaude` et en ajouter dans `remote` avant activation.

## 8. Double revue Codex 5.5 xhigh

Note de methode : les tentatives de lancer un sous-agent via `codex exec -m
gpt-5.5-codex` ont echoue avec le compte local (`model is not supported when
using Codex with a ChatGPT account`). La double revue ci-dessous est donc faite
par l'agent principal Codex 5.5 xhigh, en deux passes separees et adversariales.

### 8.1 Revue A — architecture, continuite, securite

Verdict : **GO pour Slice 0 uniquement ; NO-GO implementation proxy tant que
les decisions D2/D3/D5/D6 ne sont pas tranchees.**

Findings :

- **Proxy placement est une decision bloquante, pas un detail.** Un proxy local
  ne peut pas servir de fondation aux sessions remote si le laptop dort ou si le
  tunnel tombe. Un proxy control-plane/pod-side expose plus de secrets et cree un
  service multi-session a securiser. Il faut choisir le mode de la premiere
  slice avant toute injection d'URL proxy dans les sessions.
- **Le sticky binding doit etre une primitive de session, pas un effet du
  load-balancer.** Le compte choisi doit etre persisté avec l'identite de session
  (`remote run`, `remote delegate`, `restore`, `refresh`, relaunch) et jamais
  recalcule au milieu d'une conversation. Le planner doit etre pur et teste avec
  concurrence, sessions deja bindees, comptes indisponibles, et override manuel.
- **Pas de fallback silencieux intra-session.** Si un compte rate-limit ou tombe
  en erreur pendant une session, basculer automatiquement vers un autre compte
  peut casser la continuite provider/conversation et rendre les audits faux. Le
  fallback automatique est acceptable seulement avant le premier message d'une
  nouvelle session, ou apres action explicite de l'utilisateur.
- **`llm-mesh@0.4.0` est une dependance de contrat.** Le checkout local lu est
  `0.2.0`; il ne prouve pas le support Claude Code executable. Tant que l'API
  0.4.0 n'est pas presente dans l'environnement, WP16 doit rester en cadrage.
- **La symetrie Claude<->Codex n'est pas acquise.** Claude Code parle une forme
  Anthropic `/v1/messages`; Codex CLI n'a pas forcement une surface equivalente
  injectable vers un proxy Anthropic. Il faut verifier les points d'injection
  par CLI, pas seulement les conversions HTTP de `teamclaude`.
- **Descriptor/secret split obligatoire.** Les diagnostics et manifests doivent
  manipuler des descriptors rediges (`accountId`, provider, label, expiry,
  health), jamais les tokens. Les secrets ne vont ni dans `track`, ni dans les
  logs, ni dans un manifest de drift.

Decisions requises avant implementation :

- Choisir la topologie de la premiere slice : local-only dry-run, proxy local,
  proxy control-plane, proxy pod-side, ou hybride.
- Definir l'identite de binding : cle session, cle lineage, profile, workspace,
  et comportement sur restore/refresh/delegate.
- Decider si un compte peut etre partage en concurrence ou reserve par session.
- Valider le contrat exact `llm-mesh@0.4.0` pour `claude-code` et `codex`.

### 8.2 Revue B — UX, operations, deployabilite

Verdict : **GO pour cadrage + dry-run ; l'UX doit rester opt-in tant que les
secrets et la topologie proxy ne sont pas stabilises.**

Findings :

- **Le modele utilisateur doit rester simple : "pool disponible", pas
  "provider gateway".** La commande doit dire quel compte est bindé et pourquoi,
  mais ne pas forcer l'utilisateur a connaitre les details `llm-mesh`.
- **La selection de compte doit etre observable.** `remote status` ou equivalent
  doit afficher session -> account descriptor, proxy reachability, dernier health
  check, et raison de selection. Sans diagnostic, les pannes seront impossibles a
  distinguer entre quota, proxy, auth, ou CLI.
- **Les sessions existantes ne doivent pas changer de comportement par defaut.**
  L'activation du pool doit etre explicite (`--account`, config workspace, ou
  commande de setup), sinon WP16 peut modifier des sessions stables.
- **Remote pods et laptop sleep sont le test operateur central.** Si une session
  remote depend d'un proxy local, le diagnostic doit dire "proxy unreachable" et
  ne pas masquer le probleme par une erreur provider.
- **Le menu `remote` sans option et WP16 vont se croiser.** Si un menu choisit
  `claude`, il doit aussi pouvoir afficher le compte qui sera utilise ou laisser
  le mode "auto". Le menu ne doit pas cacher une selection de compte risquee.
- **Mistral/Gemini/AGY ne doivent pas etre ajoutes au pool par analogie.**
  Chaque profil doit declarer ses capacites : CLI interactive, API proxyable,
  auth non-interactive, resume, h2a, plugin/MCP.

Premiere slice recommandee :

1. Ajouter un **mode dry-run sans secret** : liste les comptes descriptors,
   sessions connues, et le binding qui serait choisi.
2. Ajouter un **planner pur de sticky binding** avec tests de concurrence et
   d'override manuel.
3. Ajouter une **matrice de capacites par CLI** (`claude`, `codex`, `agy`,
   `gemini`, `mistral`) pour separer "run interactive" de "proxyable".
4. Integrer `../teamclaude` seulement comme reference de conversion/proxy, pas
   comme source de verite de session.

### 8.3 Reconciliation adoptee

Le cadrage WP16 reste en STUDY, mais la direction est resserree :

- **D-WP16-1 : Slice 0 = aucun secret, aucun proxy actif par defaut.** On livre
  d'abord descriptors, planner de binding, diagnostic dry-run et matrice de
  capacites.
- **D-WP16-2 : sticky binding = invariant dur.** Un compte choisi pour une
  session ne change pas sans action explicite, meme en cas de rate-limit.
- **D-WP16-3 : topologie proxy = decision owner avant implementation.** Local,
  pod-side, control-plane ou hybride changent la securite et la durabilite.
- **D-WP16-4 : `llm-mesh@0.4.0` doit etre present et verifie.** Le checkout
  `0.2.0` ne suffit pas pour coder le support Claude Code.
- **D-WP16-5 : diagnostics redactes obligatoires.** Toute surface utilisateur
  affiche des descriptors, jamais du materiel secret.
