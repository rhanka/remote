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

*Sections suivantes (Cadrage / Revues / Spec consolidée) ajoutées après ce commit.*
