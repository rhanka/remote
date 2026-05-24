# Feedback UAT Track 2 — 2026-05-24

> Capture **brute** des retours utilisateur après exécution du runbook `2026-05-24-uat-track2-ready.md`.
> À traiter ensuite (priorisation + design + implémentation). Aucun verbe / aucune sémantique ne doit être considéré comme acté à ce stade.

## Convention de nommage globale

- Préférer **`agy`** plutôt que `antigravity` partout (verbe CLI, alias, profiles ID, messages, docs internes).
- Garder `antigravity` **seulement** dans les mentions produit / vendor (« Antigravity CLI by Google », « shares Google OAuth … »).
- Idem côté `claude` vs `claude-code` (cf. retour 4 ci-dessous).

## 1. `remote auth <profile>`

- a. ✅ Fonctionne.
- b. UX et verbe à retravailler. Aujourd'hui c'est implicite « je bundle tes creds locales vers le remote ». Il faut être explicite et responsable :
  - Soit demander une **confirmation** à l'utilisateur (« j'envoie ces fichiers vers la session remote, OK ? »).
  - Soit développer les **options du verbe** pour qu'on choisisse explicitement le sens :
    - `remote auth --export <profile>` (depuis local)
    - `remote auth --import <profile>` (vers session remote)
    - `remote auth --local-to-remote <profile>`
  - Prévoir un `--all` (ou similaire) pour copier toutes les auths d'un coup.
  - Prévoir un **mode où l'on n'est pas déjà authentifié en local** :
    - Soit donner la commande locale à lancer (`codex login` / `claude auth login` / `agy` login flow).
    - Soit encadrer l'enrôlement local via `remote auth`.
    - Soit encadrer directement l'enrôlement **remote** (login dans le Pod avec callback géré).
  - Étudier les pratiques d'autres CLIs / produits similaires (gh, gcloud, doctl, codex, claude, agy eux-mêmes) pour proposer une interaction « responsable » : pas de copie en douce, signaux clairs sur ce qui sort de la machine.

## 2. `remote smoke <profile>`

- a. ✅ Fonctionne.
- b. **Ne devrait pas être une fonction utilisateur** (le mot « smoke » est jargon interne). Options possibles :
  - Renommer en verbe `check` ou `test` plus user-facing (`remote check <profile>`, `remote test <profile>`).
  - OU exposer ça comme une **option** d'un verbe existant (`remote <profile> --smoke` ou `--dry-run`).
  - À designer.

## 3. Lancement profil en mode `--remote`

État observé :

- `codex` : OK, se logue, **mais `--remote` attend une URL** (alors que ça fonctionne sans URL grâce au `remote config`).
  - Confirmer que `--remote` (sans valeur) doit utiliser le default `remote config` posé.
  - Ne pas mettre `--remote` par défaut implicite : « ça n'a pas de sens sans argument », il faut le verbe explicite.
- `claude` : **redemande de s'authentifier** dans le Pod. → le bundle des creds ne suffit pas, à investiguer (clé manquante ? chemin différent ? signature device ?).
- `antigravity` (`agy`) : **ne lance pas `agy` du tout**, se logue en root (shell).
  - Probablement un fallback vers `/bin/bash` côté session-agent malgré l'image fraîche. À investiguer (peut-être un cache image résiduel, ou un mismatch entre profil reçu et `PROFILE_COMMANDS`).

UX souhaitée (au-delà de la correction des bugs) :

- Soit on est dans un **répertoire déjà mappé à un workspace remote** → on attache automatiquement au workspace mappé.
- Soit **pas de workspace mappé** → on **propose** un mapping (création nouveau workspace remote), avec option de :
  - **sync des fichiers** local → remote
  - **import** d'une **session existante** (reprise)
- Prévoir une option `--resume` qui mappe sur les options natives :
  - `codex --continue` / `codex resume <id>`
  - `claude --resume <id>`
  - `agy --continue` / `agy --conversation <id>`
  - À utiliser pour reprendre **une ancienne session déconnectée** (différent d'`attach` à une session vivante).

## 4. `remote ls`

- ✅ Fonctionne.
- Améliorer le rendu :
  - Afficher **`claude`** au lieu de `claude-code`.
  - Afficher **`agy`** au lieu de `antigravity`.
  - Garder `codex` / `opencode` / `shell` tels quels.
  - Ajouter la **session id de la CLI elle-même** (côté codex, claude, agy) en plus de la session remote, idéalement **après PROFILE**.
  - À designer : nouvelle colonne « CLI_SESSION » ou format `PROFILE/CLI_SESSION`.

## 5. `remote refresh <sid>`

- ✅ Fonctionne.
- a. **N'a pas compris ce que ça fait** → besoin de documentation user-facing claire (qu'est-ce qui est refresh, depuis où, vers où).
- b. **`--profile` ne devrait pas être obligatoire ni recommandé** :
  - Le control-plane connaît déjà le profil de la session.
  - `remote refresh <sid>` doit toujours auto-détecter le profil et bundler les creds **du même profil**.
  - Garder `--profile <name>` seulement pour les cas tordus (overload manuel), pas dans le runbook usuel.

## 6. `remote attach <sid>`

- a. ❌ Comportement piégeant : un `Ctrl+D` a fermé l'attach **et la session derrière**.
- UX souhaitée :
  - **Distinguer clairement** « sortie du terminal d'attach » (déconnecter sans tuer la session) vs « sortie de la CLI distante » (tuer la session).
  - Convention possible : `Ctrl+P Ctrl+Q` pour détacher (style docker attach), `Ctrl+D` ne devrait pas tuer la session.
  - Bandeau d'aide initial (ex: `[remote] press Ctrl+P Ctrl+Q to detach, type 'exit' to end the session`).
- Cycle de vie attendu :
  - **Quand on quitte la session pour de bon**, l'ancienne session doit disparaître de `remote ls`.
  - Et surtout le **conteneur** doit être fermé en cascade.
  - Prévoir éventuellement une option `remote ls --all` (ou `--history`) pour voir les sessions passées si on veut.

## 7. `remote stop <sid>`

- ✅ Fonctionne.
- Cependant : « les sessions étaient déjà stoppées à mon sens » → cohérent avec le point 6 (si `Ctrl+D` a tué la session côté CLI, le stop arrive sur quelque chose de déjà mort).
- À retraiter après 6.

## Récap actions à instruire (à prioriser ensuite)

1. **Rename global `antigravity` → `agy`** (verbe, alias, profile id, messages, docs internes) — sauf mentions produit.
2. **Rename `claude-code` → `claude`** dans la sortie `ls` (au minimum) et probablement comme profile id canonique.
3. **Redesign `auth`** (verbes explicites, `--all`, mode local-non-auth, confirm copie).
4. **Renommer/déplacer `smoke`** (devenir `check`/`test` ou option `--smoke`/`--dry-run`).
5. **Workspace mapping** côté `remote codex` / `remote claude` / `remote agy` (auto-attach si mappé, sinon proposer mapping + sync + import).
6. **`--resume` natif** sur tous les profils (continue / resume / conversation).
7. **Corriger** `claude` qui redemande auth dans le Pod (probable bug bundle).
8. **Corriger** `agy` qui ne lance pas le binaire (probable mismatch profile→command dans l'image active).
9. **`refresh` sans `--profile`** par défaut (auto), doc explicative.
10. **`attach` propre** : signal de détach distinct, `Ctrl+D` ne tue plus la session, cleanup cascade à la sortie réelle, `ls --all` pour l'historique.

## Notes

- Inputs collectés au cours du UAT du 2026-05-24, env k3d local `sentropic-remote`, port-forward localhost:8080.
- Aucune correction n'a été apportée à ce stade ; cette doc est le snapshot brut.
