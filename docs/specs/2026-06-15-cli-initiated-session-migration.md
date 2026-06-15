# Spec — Migration de session pilotée depuis le CLI (local ⇄ remote), sync continue

Statut : **INTENT (volonté brute, non encore cadrée)** — sédimenté le 2026-06-15.
Cadrage opus-4.8 + double revue (codex 5.5 xhigh + opus 4.8) à suivre dans ce
même document (sections « Cadrage » puis « Revues » puis « Spec consolidée »).

> ⚠️ Cette première section est la **volonté de l'utilisateur, verbatim/fidèle**.
> Elle ne doit pas être édulcorée lors du cadrage : toute déviation doit être
> justifiée explicitement dans la section Cadrage.

## 1. Volonté (verbatim, reformulée fidèlement)

Depuis une CLI (claude **ou** codex) en cours, l'utilisateur doit pouvoir
**donner l'instruction de migrer la session en remote**. L'appel doit :

1. **Préparer la session remote** pour qu'elle soit prête (pod k8s, RWX,
   plugins, auth, conversation).
2. **Renvoyer le statut de readiness** (prêt / pas prêt, et pourquoi).
3. **Quitter le processus local** et **relancer la même session sur k8s**.
4. On doit **se retrouver dans le même état, avec les mêmes plugins**.

Transitions de lieu :

- Il faut peut-être **gérer avec h2a les transitions de lieu d'une même
  session** (la session est une entité unique qui se déplace local↔remote).
- Il faut permettre le **mouvement inverse** (revenir en local).

Stratégie de sync (primo-migration) :

- Pour une **primo-migration**, il est acceptable que la sync prenne un peu de
  temps, **mais alors les éléments permettant de migrer sont indiqués**.
- Si des **fichiers lourds** sont la cause, une **stratégie de priorisation**
  permet de **reprendre la session en remote en mode « lazy files »** (on
  transite tout de suite), **mais la sync se poursuit en background** même si on
  a déjà transité, **en rappelant qu'il reste des fichiers à sync**.

Conscience du statut / fermeture du laptop :

- L'utilisateur doit pouvoir **fermer son laptop en ayant conscience du statut**
  (dépendance à quelques fichiers encore non synchronisés) pour pouvoir
  **prendre la décision** de fermer ou pas.
- À la **réouverture**, le cas échéant, **la sync doit pouvoir reprendre** avec
  **reconnexion de session** le cas échéant.

Resync permanente (après la 1re sync) :

- Quand on a déjà eu une première sync, la **resync doit être permanente** entre
  remote et front, avec un **gap de moins de 5 min**, **que ce soit fichiers ou
  contenu de session**.
- Objectif : que la **resync prenne toujours moins de 2 min**.

## 2. Exigences connexes (régressions/manques constatés le 2026-06-15, à intégrer au cadrage)

Ces points sont apparus pendant la session de travail et font partie du même
thème « cycle de vie / déplacement d'une session » :

- **R1 — Statut d'activité dans le nom de l'onglet (SPEC OBLIGATOIRE, régressé).**
  Les CLI (claude/codex) doivent pouvoir **actualiser le statut d'activité rendu
  dans le nom du tab** (terminal/tmux), en local **et** en remote attaché.
  C'est une régression à corriger. Mécanisme existant : `tmux set-titles on` +
  `set-titles-string=#{?pane_title,#{pane_title},#{window_name}}` + `allow-rename
  on`, `automatic-rename` jamais forcé off (cf. `packages/remote-cli/src/tmux.ts`).
  Hypothèse à vérifier : le `displayName`/`SESSION_DISPLAY_NAME` (rename) fige le
  nom de fenêtre et masque le `pane_title` dynamique → à concilier (nom de
  session ≠ statut d'activité ; les deux doivent coexister).
- **R2 — Renommer une session doit être possible et léger.** Aujourd'hui le seul
  chemin (`remote refresh --name`, v0.5.16) **recrée le pod** (lourd, ~1-2 min,
  fragile au tunnel). Il faut un rename **self-service** et **sans recreate**
  (soft), propageable au `remote ls` et au tab.
- **R3 — Robustesse du tunnel.** Le chemin `remote refresh` (hard) ne se
  reconnecte pas seul (`ECONNREFUSED 127.0.0.1:8080` après un rollout
  control-plane / sleep laptop). Il doit appeler `ensureConnected` comme
  `--soft`/`--all`.

## 3. Contraintes & invariants du projet (rappel pour le cadrage)

- Monorepo npm workspaces ; control-plane Hono + Ajv (JSON Schema source de
  vérité, pas de Zod) ; TS strict `exactOptionalPropertyTypes` ; vitest ; tsup.
- RWX **partagé par utilisateur** (un volume, subPath par workspace) sur SCW
  Kapsule ; **id de workspace durable** `ws:<hex>` = `sha256(rootCommitSHA + "\n"
  + worktreeRelPath)`, byte-identique remote/track/h2a.
- Conversation : montée déclarativement depuis le RWX ; **clé-projet canonique**
  côté pod = cwd (`/workspace` → `-workspace`) ; `--resume` ne résout que sous la
  clé du cwd (cf. P0.3, `canonicalizeConversationKey`).
- **Anti-éviction** : caches/tmp sur emptyDir borné `/scratch`, worktrees sur le
  RWX (v0.5.15). Quota tenant serré → attention aux stratégies create-before-delete.
- **Durabilité control-plane** : store repeuplé par `session.announce` à chaque
  (re)connexion agent.
- h2a : réseau d'agents file-based (`~/h2a-workspace/.h2a`), présence de session
  déjà projetée par l'agent (DEC-059).
- Velocity : publication directe sur main, jamais de squash ; specs dans le
  harness/track (pas le flow superpowers).

## 4. Questions ouvertes à trancher au cadrage (non exhaustif)

- Quelle **entité** porte l'identité unique d'une session mobile (le `ws:<hex>`
  durable ? un `session lineage id` distinct du `sess-…` éphémère ?) et comment
  h2a arbitre la **localisation courante** (local vs remote) sans double-exécution.
- **Moteur de sync** fichiers : mutuel/bidirectionnel < 5 min de gap, < 2 min de
  durée. Candidats (à challenger) : git-based, rsync-over-exec, mutagen/unison,
  CRDT pour le contenu de session. Gestion conflits (qui gagne ?).
- **Sync du contenu de session** (conversation `.jsonl` + état CLI) distinct de
  la sync fichiers : fréquence, granularité, idempotence, anti-corruption.
- **Lazy-files** : critère de seuil (taille/temps), ordre de priorisation,
  surface UX du « reste à sync », garde anti-perte si fermeture laptop.
- **Readiness** : définition machine du « prêt » (auth ok, plugins ok, repo
  bootstrappé, conv résolvable) et contrat de retour.
- **Plugins parity** : comment garantir « mêmes plugins » local↔remote
  (manifest plugin/MCP déjà existant — cf. slice 3 / `plugin-manifest`).
- Réutilisation vs refonte de `remote migrate forward|back` existant.

---

## 5. Cadrage (opus 4.8) — architecture proposée

> Brouillon de cadrage soumis à double revue (codex 5.5 xhigh + opus 4.8) — voir
> §6. Les choix sont des **recommandations argumentées**, pas des décisions
> finales.

### 5.1 Modèle d'identité d'une session mobile

Trois identités distinctes, déjà partiellement présentes :

- **`ws:<hex>` (workspace durable)** — `sha256(rootCommitSHA+"\n"+worktreeRelPath)`,
  byte-identique remote/track/h2a. C'est l'ancre du *contenu* (fichiers + conv).
- **`lineage id` (NOUVEAU)** — identité logique de la session qui se déplace,
  stable à travers local↔remote. Proposé : `lin:<hex>` dérivé de
  `ws:<hex> + profile` (une session claude et une codex sur le même workspace
  sont deux lineages). Le `sess-…` (pod) et le PID/slug tmux local restent des
  *incarnations* éphémères d'un lineage.
- **`cliSessionId` (conv)** — l'id de conversation du CLI, déjà détecté/reporté.

**Décision R-ID** : introduire `lineage id` comme clé pivot. h2a et `remote ls`
corrèlent local+remote par `lineage id` (et non plus par chemin, fragile).

### 5.2 Arbitrage de localisation via h2a (anti split-brain)

Invariant dur : **un seul exécuteur actif par lineage** (jamais claude qui tourne
en local ET en remote sur le même workspace → corruption conv + fichiers).

- h2a tient un **bail de localisation** par lineage :
  `~/h2a-workspace/.h2a/locations/<lineage>.json = {location: local|remote,
  holder: <pid|pod>, since, heartbeat, syncState}`.
- Migration = **handoff transactionnel** : (1) destination prépare + atteint
  readiness, (2) source *checkpoint* (flush conv + fichiers hot), (3) bail
  transféré atomiquement, (4) source quitte le process, (5) destination relance.
- Heartbeat : un holder mort (pas de heartbeat depuis N) libère le bail
  (récupération après crash/laptop fermé sans handoff propre).
- Réutilise la présence de session déjà projetée par l'agent (DEC-059).

### 5.3 Readiness (contrat machine)

`readiness = AND(auth_ok, plugins_parity_ok, repo_bootstrapped, conv_resolvable,
hot_set_synced)`. Retour structuré : `{ready: bool, blockers: [...], pending:
{files: n, bytes: m}, mode: full|lazy}`. `plugins_parity_ok` réutilise le
manifest plugin/MCP existant (slice 3). `conv_resolvable` réutilise
`canonicalizeConversationKey` (P0.3).

### 5.4 Moteur de sync — DEUX flux séparés

**Flux 1 — Contenu de session (petit, chaud, prioritaire).**
Conversation `.jsonl` + état CLI. Réutilise `remote sync`/`diff` (base64 over
kubectl exec, garde anti-écrasement + backup `.bak`). Rendu **continu +
bidirectionnel** par un watcher (debounce sur écriture conv). Cible : gap < 30s
(bien sous les 5 min) car petit.

**Flux 2 — Fichiers du workspace (gros, tiède).**
Recommandation : **deux couches**.
- *Tracked (git)* : la source de vérité reste git sur le RWX ; un push/pull
  (ou bundle) couvre l'historique + le suivi, conflit-aware nativement.
- *Working set non-commité* : delta **rsync-over-kubectl-exec** (ou `tar`
  incrémental) piloté par un watcher (inotify local + poll remote), priorisé.

**Choix de moteur (à challenger en revue)** : préférer un moteur **maison léger**
(watcher + rsync/tar delta) à un démon tiers (mutagen/unison) pour ne pas
introduire une dépendance lourde non auto-hébergée dans le pod, MAIS si le SLO
< 2 min / < 5 min n'est pas tenable proprement, adopter **mutagen** (continuous
two-way, conflict modes) comme moteur du Flux 2. Décision déléguée à la revue
(coût d'intégration vs garantie SLO).

**Conflits** : last-writer par mtime au niveau fichier pour le working set ;
pour la conv, la garde existante (refus d'écraser le côté en avance + backup) ;
jamais de merge silencieux destructif.

### 5.5 Lazy-files + conscience de fermeture laptop

- **Hot set** (sync avant readiness) = fichiers trackés + conv + fichiers
  récemment modifiés/ouverts. **Cold/heavy set** = le reste (seuil : fichier
  > 25 Mo OU total restant > 200 Mo → mode `lazy`).
- En mode lazy : transit immédiat, **sync bg** continue, et le « reste à sync »
  (n fichiers / m Mo, + lesquels sont bloquants) est **rendu en continu** dans la
  CLI ET dans le statut du tab (lien avec R1).
- **Fermeture laptop** : `remote status` (et un indicateur tab) affichent un
  verdict net : `SAFE TO CLOSE` (tout synchronisé OU le pending n'est pas requis
  côté remote) vs `PENDING: k fichiers — reprendra à la réouverture`. L'utilisateur
  décide. À la réouverture, le watcher se reconnecte (`ensureConnected`) et
  **reprend** le pending + la session.

### 5.6 Déclenchement « depuis la CLI »

L'instruction part de l'intérieur de la session claude/codex. Options :
- (A) **commande `remote` dans un autre pane / la side-window h2a** :
  `remote migrate to-remote` / `to-local` — simple, pas d'intrusion dans le CLI.
- (B) **sentinelle/hook** : un hook de fin de tour (claude SessionEnd / un
  marqueur que l'agent watch) déclenche le handoff — « depuis la CLI » au sens
  strict.
- (C) **enveloppe h2a** `session-migrate-request` postée par l'agent.
Recommandation : (A) comme surface utilisateur + (C) comme transport interne
(h2a porte la demande, le bail, et l'état de sync). (B) en option ergonomique.

### 5.7 Réutilisation de l'existant

- `remote migrate forward|back` : socle de la primo-migration (link workspace,
  push, create session, handoff terminal / pull-back). À **étendre** (lazy,
  readiness, bail h2a) plutôt que réécrire.
- `remote refresh --soft`, `plugin-manifest`, `canonicalizeConversationKey`,
  `session.announce`, présence DEC-059, `ensureConnected` : briques réutilisées.

### 5.8 Phasage proposé

- **Phase 0 (quick wins, débloquants)** : R3 (auto-reconnect tunnel sur refresh
  hard), R2 (rename soft sans recreate), R1 (statut d'activité du tab — concilier
  displayName statique vs pane_title dynamique).
- **Phase A (lifecycle)** : `lineage id` + bail de localisation h2a (exclusion
  mutuelle + heartbeat) + contrat readiness + `migrate to-remote/to-local`
  étendant `migrate forward/back`, **mode full** (sync complète avant transit).
- **Phase B (sync continue + lazy)** : Flux 1 (conv continue bidirectionnelle) +
  Flux 2 (fichiers, watcher + delta) + mode lazy + conscience fermeture/réouverture
  + SLO resync < 5 min gap / < 2 min durée + indicateurs CLI/tab.

### 5.9 Risques / pièges identifiés

- **Split-brain** (double exécuteur) → bail h2a obligatoire AVANT toute relance.
- **Corruption conv** sur sync concurrente → garde existante + séquencement
  checkpoint→handoff.
- **SLO sync** difficile à tenir sur gros repos → mode lazy + métrique honnête
  (jamais prétendre « synced » si pending).
- **Quota tenant / éviction** : la primo-migration crée un pod ; respecter
  create-before-delete + quota (cf. mémoire refresh-quota).
- **Sécurité** : ne jamais transiter de secrets en clair ; réutiliser le
  bundling auth + Secret existant.

---

## 6. Revues (codex 5.5 xhigh + opus 4.8)

### 6.1 Revue opus 4.8 (architecte, vérifiée contre le code) — verdict : **GO avec réserves**

Critiques majeures (toutes vérifiées dans le code) :

- **5.1 identité — formule fausse.** `lineage = hash(ws+profile)` casse : `ws:<hex>`
  inclut `rootCommitSHA` → bouge à chaque `git commit` → l'identité de la session
  mobile change *pendant* le travail. ➜ `lineage id` doit être **opaque, frappé
  une fois, persisté dans `.remote/lineage.json`** (à côté du `workspace.json` lu
  par `migrate.ts`), dérivé de rien. `ws:<hex>` = ancre du contenu (subPath RWX) ;
  `lineage` = ancre de l'identité mobile. Relation lineage→N ws.
- **5.2 bail h2a — FAUX VERROU DISTRIBUÉ (point dur).** `h2a-presence.ts` =
  projection pure (`writeFileSync` sans temp+rename/O_EXCL/CAS). Un JSON sur RWX
  partagé (NFS/CephFS) n'est ni atomique ni exclusif ; `O_EXCL`/`rename` non
  fiables sur NFS. Le heartbeat sans **fencing token** = zombie de réveil : laptop
  dort → lease expire → pod reprend → laptop se réveille offline et flush la conv
  → **corruption dans le flux NOMINAL** (fermer/rouvrir = le cas d'usage §1).
  ➜ **Autorité = control-plane** (déjà CAS-capable : `workspaces.ts:68` soft-lock
  `Map`), étendu en **lease de lineage + fencing token monotone** + **persistance
  au rollout** (via `session.announce` au reboot, sinon R3 perd tous les baux).
  h2a reste observabilité, **jamais** l'exclusion mutuelle.
- **5.3 readiness.** `conv_resolvable` doit **résoudre réellement** la conv côté
  pod (fichier présent sous la clé encodée), pas supposer la parité de chemin
  (diverge si `$HOME`/path multi-machine). `hot_set_synced` dans le AND
  **contredit** le mode lazy → le `mode` (full|lazy) doit conditionner le AND.
- **5.4 sync — SLO irréaliste + « réutilise » trompeur.** `sync.ts` lit/écrit le
  `.jsonl` **entier** en base64 (pas d'append ; `maxBuffer 512MB`). Le `.jsonl`
  **n'est pas append-only fiable** (compaction/sidechains claude réécrivent le
  préfixe ; l'état `diverged` existe déjà). ➜ Flux 1 = **incrémental par offset
  avec garde de préfixe (sha du préfixe commun)**, fallback whole-file+`.bak`.
  Flux 2 : `workspace-sync.ts` = **tar complet plafonné 256 Mo**, `.git` gaté
  128 Mo → rsync/watcher = **net-new**, et `rsync-over-kubectl-exec` passe par le
  port-forward instable (R3) **sans reprise**. ➜ source de vérité fichiers =
  **git** (delta natif, conflit-aware, reprenable, gh auth déjà bundlé) ;
  **node_modules/artefacts jamais syncés → reconstruits in-pod (`npm ci`) =
  blocker de readiness** ; working set non-commité (petit) = rsync-over-exec.
  Conflits : **garder le 3-way merge + base snapshot existant**
  (`mergeWorkspaceArchive`), pas du last-writer-mtime (mtime non fiable
  cross-machine). **SLO `<2min/<5min` = métrique observée, pas contrat binaire.**
- **5.5 lazy/fermeture — 3 trous de perte.** (1) flush conv local non poussé
  avant reprise pod lazy → `diverged` ; barrière de checkpoint + fencing token
  obligatoires. (2) verdict `SAFE TO CLOSE` calculé localement = faux positif ;
  doit être **conservateur** (1 octet de delta non confirmé-reçu = `PENDING`).
  (3) seuils 25/200 Mo arbitraires → critère = **temps de transfert estimé**
  (10⁴ petits fichiers tuent rsync plus qu'un fichier de 200 Mo).
- **5.6 déclenchement.** (A) `remote migrate to-remote/to-local` = bon (c'est ce
  que `migrate.ts` fait déjà, il tient le terminal via `attach`). (C) h2a comme
  transport interne = **sur-architecturé** (appel control-plane synchrone existe
  déjà). (B) utiliser le hook **Stop** (fin de tour), pas `SessionEnd` (trop tard).
- **5.7 réutilisation — honnêteté.** Sur 6 briques « réutilisées » : 2 réelles
  (`migrate forward` mode full ; websocket self-healing pour la reprise réseau),
  1 à corriger (`migrate back` devine la session → besoin de lineage), 3 net-new
  (Flux 1 incrémental, Flux 2 delta/watcher, lease/fencing).
- **5.8 phasage.** Ajouter une **Phase A0** : décider+prototyper lease/fencing au
  control-plane **avant** `migrate to-remote`. Régler le **cap 256 Mo /
  node_modules / .git avant** le mode full (sinon `migrate forward` throw sur tout
  vrai repo). Découper Phase B (B1 conv incrémentale, B2 git+working set, B3
  lazy+fermeture). SLO = métrique, pas critère.

5 risques non couverts : (1) pas de fencing token → zombie de réveil corrompt la
conv (flux nominal) ; (2) control-plane in-memory perd l'autorité au rollout ;
(3) `.jsonl` non append-only fiable → ni whole-file ni append naïf ne tiennent
SLO+intégrité sans garde de préfixe ; (4) transport (port-forward/exec) = maillon
le plus fragile, sans reprise de transfert ; (5) quota tenant + pic
create-before-delete pendant le handoff à chaud (2 pods/incarnations transitoires
sur le même subPath) → échec à mi-chemin sans rollback.

3 simplifications YAGNI : (1) **supprimer le bail file-based** (autorité
control-plane unique) ; (2) **pas de moteur de sync continu fichiers en V1** (git
+ working set seulement, node_modules reconstruits) ; (3) **SLO = transparence
mesurée**, pas garantie de latence.

### 6.2 Revue codex 5.5 xhigh — *(en cours, ajoutée à l'itération suivante)*

## 7. Spec consolidée — après réconciliation des revues
