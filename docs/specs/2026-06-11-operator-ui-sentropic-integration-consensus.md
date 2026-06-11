# operator-ui → sentropic.sent-tech.ca — consensus d'intégration

Statut : **proposition (consensus opus 4.8 + Fable 5)**. Input archi sentropic
**demandé via h2a** (`claude:sentropic` conductor + architecte) — à folder dès réception.
Date : 2026-06-11.

## Besoin (product owner)
L'operator-ui de `remote` cesse d'être une console standalone et devient des **vues
de `sentropic.sent-tech.ca`** : (a) une vue **« code workspace » utilisateur**, (b) une
vue **admin / panel**. Avec **enrôlement**, gestion **profils + workspaces**, et une
**auth autonomisable (self-service)**.

## Consensus par axe

### 1. Topologie → **bibliothèque de vues Svelte publiée** `@sentropic/remote-views-svelte`
`SessionsView` / `WorkspacesView` / `TerminalView` / `AdminRemoteView` + un client headless
**`RemoteApiClient` injectable** (`baseUrl` + `getToken()`/`fetch`). `apps/operator-ui`
devient un harnais de dev qui monte les mêmes composants.
- **Pourquoi** : les deux côtés sont Svelte 5 + le même DS → module-federation = surcoût inutile ;
  iframe casse SSO/théming/deep-link ; réécriture native duplique le terminal xterm/SSE et
  orpheline `@sentropic/remote-protocol`. La lib est l'option **la moins engageante** (sentropic
  reste libre de la consommer comme il veut).
- **Conséquence** : `resolveApiBase()` (localStorage) disparaît au profit de l'injection ;
  SSE terminal passe d'`EventSource` à **fetch-streaming** (headers d'auth + survit au proxy).

### 2. Frontière user-view / admin-view
- **`/workspace`** (rôle `remote:user`) : ses propres workspaces + sessions (depuis profils *accordés*), attach terminal. Jamais de cross-tenant.
- **`/admin/remote`** (rôle `remote:admin`) : onglets Users (enrôler/suspendre), Profiles (CRUD templates), Workspaces (cross-tenant, quota/GC), Sessions (oversight, force-stop, attach read-only).
- Gating **deux fois** : le shell sentropic masque par claim de rôle ; le control-plane **ré-applique** côté serveur (`/admin/*` vérifie le rôle). L'UI gate = UX, jamais sécurité.
- *Note* : l'admin-view ≈ l'operator-ui d'aujourd'hui ; la user-view est le net-neuf (plus simple, scope perso).

### 3. Enrôlement + profils + workspaces (le control-plane n'a aujourd'hui ni users ni profils ni RBAC)
Ajouter, en JSON-Schema-first (même pattern Ajv) :
- **`/admin/users`** : POST (enrôle → `TenantProvisioner`), GET, PATCH (suspend), DELETE (offboard = GC namespace+workspaces). + **JIT enrollment** : 1ère requête authentifiée avec claim `entitlement` auto-provisionne (pré-enrôlement admin et self-service partagent le même chemin).
- **`/profiles`** (user: lit les accordés ; admin: CRUD) : **Profil = template de lancement** (CLI claude/codex/…, image/version, limites ressources, targets autorisés, policy workspace). Promouvoir le `cliProfile` embarqué actuel en `profileId` référencé sur `CreateSessionRequest` (inline gardé en back-compat CLI).
- **Grants** `userId → [profileId]` (`PUT /admin/users/:id/profiles`), enforced à `POST /sessions`.
- Stockage en **CRD/ConfigMap** dans le namespace partagé (pas de base de données). Workspace = subPath du volume RWX/user (règle existante), policy de profil = quota/taille.

### 4. Auth autonomisable → **sentropic possède l'IdP ; le control-plane reste un resource server**
- **IdP** : SSO sentropic (OIDC). Le control-plane ne fait jamais de login : il valide les JWT via le seam existant `REMOTE_AUTH=bearer` + `REMOTE_AUTH_JWKS_URL`(JWKS sentropic) + `REMOTE_AUTH_ISSUER`. = le `SentropicOIDCAuthenticator` déjà prévu dans les docs → **config, pas du code**.
- **Browser** : l'app sentropic termine la session (cookie) et expose un **reverse-proxy same-origin** `sentropic.sent-tech.ca/api/remote/*` → control-plane, en injectant le bearer. → zéro CORS, tokens hors localStorage, SSE/terminal same-origin. Le CLI continue en bearer direct.
- **Self-enrôlement** : signup sentropic → claim `entitlement remote` → 1er appel JIT-provisionne le tenant. Isolation inchangée (namespace/user, service-token par session).
- **Rôles** : un claim `remote_role: user|admin` (`REMOTE_AUTH_ROLE_CLAIM`).

### 5. Répartition du travail
**remote (ce repo)** : (1) `packages/remote-views-svelte` (extraction + `RemoteApiClient` injectable + SSE fetch) ; (2) `apps/operator-ui` → harnais de dev ; (3) control-plane : `/profiles`+grants, `/admin/users`+JIT, middleware authz rôle, `/admin/sessions|workspaces` cross-tenant, schémas protocol ; (4) profil de déploiement JWKS-vs-sentropic (+ fold du fix 1-RWX/user).
**sentropic.sent-tech.ca** : (1) IdP OIDC (claims `entitlement remote` + `remote_role`, JWKS) ; (2) routes `/workspace` + `/admin/remote` montant les vues, nav role-gated ; (3) reverse-proxy `/api/remote/*` (streaming-safe : pas de buffering, idle long) ; (4) chrome admin (les vues sont des panneaux, sentropic possède layout/nav).

### 6. Migration (pas de big-bang)
1. **Extract** (remote only) : vues → lib, operator-ui la consomme. Zéro changement de comportement, preuve CI du packaging.
2. **Auth** (config) : control-plane `REMOTE_AUTH` vs JWKS sentropic en staging ; CLI + UI passent bearer. Standalone encore fonctionnel.
3. **1er embed** (sentropic) : route `/workspace` + proxy, user-view only, JIT on. Operator-ui gardé en fallback ops.
4. **Admin** : profils/users/grants côté control-plane ; `/admin/remote` monté dans sentropic.
5. **Décommission** : operator-ui standalone → harnais de dev (non déployé).

## Risques (top 3)
1. **Couplage de versions cross-repo** (svelte/DS/protocol) → peer-deps stricts + test de contrat en CI de la lib contre la version DS de sentropic.
2. **SSE terminal à travers le proxy** (buffering/idle/backpressure peut tuer le flux xterm) → à valider en slice 1, pas à supposer.
3. **Scope creep RBAC** → garder Profil=template + grants plats + 1 claim de rôle ; orgs/teams/ACLs = IAM sentropic, pas control-plane.

## Dépendance DS (bloquante pour le « 100% DS »)
La lib doit être 100% DS — bloqué sur le **gap de conformité DS escaladé** (Card cliquable,
action-row, slot d'embed, primitives layout, mode strict-conformance). L'extraction est
**orthogonale** : on intègre avec l'UI actuelle et on resserre au fil des livraisons DS.

## 1ère slice (de-risk les 3 seams d'un coup)
Extraire `SessionsView` + `TerminalView` + `RemoteApiClient` dans `@sentropic/remote-views-svelte` ;
monter `/workspace` derrière SSO + proxy `/api/remote/*` ; control-plane sur `REMOTE_AUTH` + JWKS
sentropic. Un user liste / crée / attache un terminal e2e → exerce packaging + délégation d'auth +
SSE-through-proxy avant d'écrire la moindre API profils/enrôlement.
