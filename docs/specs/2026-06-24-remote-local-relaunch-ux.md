# Spec Study — remote local relaunch UX and llm-gateway activation

Statut : **STUDY / UX bug sedimentation** — 2026-06-24.

Finalite : relancer une session Claude locale geree par `remote` avec
`llm-mesh` actif doit etre une operation evidente et atomique. L'utilisateur ne
doit pas connaitre tmux, les noms `remote-<slug>`, le guard single-writer, ni
la difference entre "Claude actif" et "Claude a quitte vers un shell
persistant".

## 1. Incident observe

Contexte utilisateur :

- Claude a atteint la limite hebdomadaire du compte subscription.
- `remote llm-mesh` tourne localement et expose la gateway sur
  `http://localhost:3002`.
- `remote run claude ...` affiche bien :

```text
[remote] llm-mesh: injecting gateway env (http://localhost:3002)
```

Mais la relance reste confuse :

- `remote run claude /home/antoinefa/src/remote --name remote -r
  6f3933eb-7247-4a24-a9d2-fe6118648f56` peut annoncer une session "started"
  alors qu'une session tmux `remote-remote` existe deja.
- `remote attach remote`, lance depuis un terminal deja dans tmux, peut echouer
  avec le message tmux :

```text
sessions should be nested with care, unset $TMUX to force
```

- Une session existante peut etre attachee mais ne contenir qu'un `bash` :
  Claude est sorti vers le shell persistant, mais l'outil et le registre la
  presentent encore comme une session pertinente.

Conclusion : l'outil donne des commandes qui semblent correctes, mais leur
effet reel n'est pas celui que l'utilisateur cherche. C'est un bug produit, pas
une erreur d'utilisation.

## 2. Contraintes non negociables

- `llm-gateway` doit rester transparent : injection par variables
  d'environnement au process lance, aucune ecriture dans la configuration
  Claude.
- `remote` ne doit jamais recommander un `--force` implicite pour contourner le
  guard single-writer. Deux writers sur le meme `.jsonl` Claude peuvent
  corrompre la conversation.
- Une commande qui ne lance pas un nouveau Claude ne doit jamais afficher
  "started".
- Une commande de relance doit etre scriptable : le code de sortie doit
  distinguer "Claude lance" de "rien n'a change".
- Les sessions locales et remote peuvent partager des noms visibles, mais la
  resolution doit rester explicite et diagnostiquable.

## 3. Decisions proposees

### D1 — `remote attach <slug>` depuis tmux

Si `remote attach <slug>` cible une session locale tmux et que `$TMUX` est
present, `remote` doit utiliser :

```bash
tmux switch-client -t remote-<slug>
```

Hors tmux, il garde :

```bash
tmux attach -t remote-<slug>
```

Le code de sortie tmux doit etre propage par `remote attach`.

### D2 — `remote run` face a une session locale existante

Avant guard single-writer, avant injection gateway et avant reecriture du
registre, `remote run ... --name <slug>` doit detecter si `remote-<slug>`
existe deja.

Comportement recommande pour la premiere correction :

- sortir non-zero ;
- ne pas muter le registre ;
- ne pas afficher `llm-mesh: injecting gateway env` ;
- ne pas appeler `startLocalSession` ;
- afficher une guidance claire :

```text
[remote] local session remote already exists; no new claude was started.
[remote] attach: remote attach remote
[remote] stop first: remote stop remote --reason restart
[remote] replace in one step: remote run ... --replace   (when implemented)
```

`--attach` peut devenir un raccourci explicite vers `remote attach <slug>` si la
session existe deja, mais ce comportement doit etre teste et documente.

### D3 — relance atomique future

La cible UX est une operation atomique :

```bash
remote relaunch remote --gateway
```

ou :

```bash
remote run claude /home/antoinefa/src/remote --name remote -r <conv> --replace
```

Cette operation doit :

1. verifier que `llm-mesh` tourne ou expliquer comment le demarrer ;
2. verifier le writer local existant ;
3. stopper/recycler proprement la session locale cible ;
4. relancer Claude avec le bon resume argv ;
5. injecter la gateway dans le vrai process spawn ;
6. afficher un recapitulatif clair :

```text
[remote] replaced local session remote
[remote] gateway active: http://localhost:3002
[remote] resumed conversation: <conv>
[remote] attach: remote attach remote
```

Cette commande ne doit pas utiliser `--force` automatiquement.

### D4 — shell persistant vs writer actif

Quand une session locale `remote-<slug>` existe mais que le pane actif est un
shell post-CLI, `remote` doit pouvoir le dire explicitement :

```text
[remote] local session remote exists but claude is not running; pane is bash.
```

Ce diagnostic peut etre un lot separe. Il ne doit pas bloquer D1/D2.

### D5 — `remote resume <slug>` comme verbe utilisateur primaire

Le workflow naturel pour l'utilisateur n'est pas `run -r`, `stop`, `attach` ou
`--force`. C'est :

```bash
remote resume remote
remote resume radar-immobilier
```

`remote resume <slug>` doit etre le verbe UX de reprise d'une session locale
connue. Il lit le registre local pour retrouver :

- le profil (`claude`, `codex`, ...),
- le cwd,
- le dernier `convId` connu,
- le nom de session tmux attendu (`remote-<slug>`).

Pour une conversation Claude ou Codex existante mais pas encore suivie par
`remote`, l'utilisateur ne doit pas repasser par `remote run`. Depuis le
repertoire du repo :

```bash
remote resume --claude [claude-conversation-id]
remote resume --codex [codex-conversation-id]
```

Quand l'id est omis, `remote` lance le flux natif du CLI (`claude --resume` ou
`codex resume`) et laisse l'utilisateur choisir dans le selecteur du CLI. Le
slug par defaut est le basename du repertoire courant. Si l'utilisateur veut un
autre nom local :

```bash
remote resume <slug> --claude [claude-conversation-id]
remote resume <slug> --codex [codex-conversation-id]
```

Pour reprendre directement la derniere conversation du CLI depuis le repo
courant, sans selecteur :

```bash
remote resume --claude --last
remote resume --codex --last
```

Pour Claude, `remote` resout le dernier fichier `.claude/projects/<cwd>/*.jsonl`
et lance `claude --resume <id>`. Pour Codex, `remote` lance le flux natif
`codex resume --last`.

Ces formes d'intention (`--claude` / `--codex`) doivent etre idempotentes :
si la session locale `remote-<slug>` existe deja et que le CLI est actif,
`remote resume ...` ne lance pas un second writer et attache directement a la
session existante. L'utilisateur ne doit pas devoir copier une deuxieme commande
`remote attach`.

Si la commande est lancee depuis un shell qui est deja dans la session tmux
`remote-<slug>`, `remote resume ...` ne doit pas "switcher" vers lui-meme puis
revenir au prompt. Il doit lancer le CLI cible dans le pane courant avec les
arguments de resume calcules.

Dans ce mode explicite, `remote resume` utilise le cwd courant, le profil
choisi, l'id fourni s'il existe, injecte `llm-mesh` si disponible, puis enrole
la session dans le registre local comme une session `remote` normale.

Comportement attendu :

1. **Aucune session tmux locale n'existe** : lancer une nouvelle session avec
   le profil/cwd/convId du registre, en injectant `llm-mesh` si disponible.
2. **La session tmux existe et le CLI cible est clairement actif** : ne jamais
   lancer un deuxieme writer. Afficher que la session est deja active et
   proposer `remote attach <slug>` ; avec une option explicite, attacher.
3. **La session tmux existe mais le pane actif est un shell post-CLI** : proposer
   une reprise/remplacement explicite.
4. **L'etat est ambigu** : ne pas deviner. Exiger une confirmation interactive
   ou sortir non-zero avec des commandes explicites.

Le verbe `remote run ... --name <slug> -r <conv>` reste une brique bas niveau :
si `remote-<slug>` existe deja, il refuse clairement et recommande
`remote resume <slug>` ou `remote resume <slug> --replace`.

Codes de sortie :

- `0` : reprise, remplacement ou attachement effectue.
- `2` : no-op attendu et non destructif, par exemple session deja active et
  aucun attach demande.
- `1` : refus, ambiguite, registre incomplet, confirmation refusee ou erreur.

Si le registre ne contient pas exactement un profil, un cwd et un `convId`
pour `<slug>`, et qu'aucun `--claude [id]` / `--codex [id]` explicite n'est fourni,
`remote resume` ne doit pas deviner et ne doit pas basculer vers un
`--continue`. Il sort non-zero avec un diagnostic bavard.

### D6 — takeover ambigu : warning + confirmation, jamais silencieux

Si `remote resume <slug>` doit remplacer une session locale existante, le
takeover doit etre explicite.

En terminal interactif (TTY), afficher un avertissement qui nomme les objets
concernes :

```text
[remote] local session remote already exists.
[remote] pane appears to be bash, not claude.
[remote] replacing it will kill tmux session remote-remote and resume
         conversation 6f3933eb-7247-4a24-a9d2-fe6118648f56 in /home/antoinefa/src/remote.
[remote] If another Claude is still writing this conversation, replacing can corrupt the .jsonl.
Type "replace remote" to continue:
```

La confirmation doit etre non accidentelle. La forme preferee est de taper
`replace <slug>`, plutot qu'un simple `y`, parce que le risque est la corruption
d'un journal de conversation.

En contexte non interactif (pas de TTY), `remote resume <slug>` ne doit pas
attendre une reponse et ne doit pas sortir silencieusement. Il doit sortir
non-zero avec une guidance explicite :

```text
[remote] local session remote already exists and takeover requires confirmation.
[remote] interactive: remote resume remote
[remote] explicit replace: remote resume remote --replace
[remote] manual path: remote stop remote --reason restart && remote resume remote
```

`--replace` est l'opt-in scriptable. Il doit encore passer par les garde-fous :

- ne pas contourner automatiquement un writer verifie actif ;
- ne pas utiliser `--force` sur le guard single-writer ;
- afficher le `convId`, le cwd, la session tmux tuee et la gateway injectee.

`--replace` n'est pas un alias de `remote run --force`. Il est valide seulement
si la session cible est clairement idle (shell post-CLI prouve), ou apres une
confirmation TTY forte dans un etat ambigu. Un writer actif verifie bloque
toujours.

La mecanique de remplacement par defaut est **kill/recreate tmux**. C'est le
chemin le plus lisible pour garantir que le nouveau process Claude herite de
l'environnement gateway. Une relance in-place n'est acceptable que si la
commande envoyee au shell prefixe explicitement les variables d'environnement
gateway, et doit etre traitee comme un design separe.

Juste avant l'action destructive, `remote resume` doit refaire un check de
l'etat de la session cible. Si le pane n'est plus idle ou si un writer verifie
apparait, l'action est annulee avec diagnostic.

## 4. Etat du diff accidentel

Un diff preliminaire a ete applique avant cette sedimentation. Il ne doit pas
etre considere livrable tel quel.

Intention du diff :

- ajouter un retour `reused` a `startLocalSession`;
- faire `remote run` afficher `already exists` au lieu de `started`;
- utiliser `tmux switch-client` dans `attachLocalSession` quand `$TMUX` existe.

Problemes identifies par la revue :

- `index.ts` perd le champ `reused` en destructurant seulement `{ name, slug }`.
- Le chemin reuse executerait encore l'injection gateway et `enrollFromRun`,
  alors qu'aucun nouveau Claude ne recoit ces variables.
- Le preflight "session locale deja existante" doit arriver avant le guard
  single-writer et avant toute mutation.
- `remote attach` doit propager le code de sortie de `attachLocalSession`.

Decision : ne pas livrer ce diff sans reprise et tests.

## 5. Tests d'acceptation minimum

### Unitaires tmux

- `attachLocalSession` appelle `tmux switch-client -t <name>` si `TMUX` est
  present.
- `attachLocalSession` appelle `tmux attach -t <name>` si `TMUX` est absent.
- `attachLocalSession` retourne le status tmux.
- `startLocalSession` ne lance pas `tmux new-session` quand la session existe
  deja.

### Wiring CLI

- `remote attach <slug>` propage le code de sortie de l'attachement local.
- `remote run ... --name <slug>` avec session existante sort non-zero et
  affiche une guidance claire.
- Dans ce cas existant, `remote run` ne doit pas afficher `llm-mesh: injecting
  gateway env`.
- Dans ce cas existant, `remote run` ne doit pas appeler `enrollFromRun`.
- Dans le cas normal sans session existante, le comportement actuel est
  preserve : injection gateway si `llm-mesh` tourne, `startLocalSession`,
  enrollment, puis indication `remote attach <slug>`.
- `remote resume <slug>` sans session tmux existante relance depuis le registre
  avec le bon profil/cwd/convId.
- `remote resume <slug>` avec CLI actif ne demarre jamais un second writer et
  recommande l'attache.
- `remote resume <slug>` avec shell post-CLI demande `replace <slug>` en TTY
  avant de tuer/recreer la session.
- `remote resume <slug>` en non-TTY, quand un takeover serait necessaire, sort
  non-zero avec guidance et ne reste jamais silencieux.
- `remote resume <slug> --replace` est l'opt-in scriptable et trace le
  remplacement effectue.
- `remote resume <slug>` avec registre incomplet ou plusieurs entrees candidates
  refuse sans deviner, sauf si `--claude [id]` ou `--codex [id]` demande
  explicitement l'enrolement depuis le cwd courant.
- `remote resume <slug> --replace` refuse si un writer actif est verifie.
- `remote resume <slug>` refait un check d'etat apres confirmation et avant
  `kill-session`.

### Manuel

Depuis un terminal deja dans tmux :

```bash
remote attach remote
```

doit basculer vers `remote-remote` sans message "sessions should be nested".

Avec une session locale existante :

```bash
remote run claude /home/antoinefa/src/remote --name remote -r <conv>
```

doit refuser clairement de pretendre a une relance.

## 6. Revue GPT-5.5 xhigh — 2026-06-24

Reviewer : sous-agent `gpt-5.5`, reasoning `xhigh`, lecture seule.

Verdict : la direction est correcte, mais le diff actuel est bloque jusqu'a
reprise.

Findings bloquants :

1. Le champ `reused` n'est pas propage dans `index.ts`; le message resterait
   `started`.
2. Le chemin session existante reste traite comme un vrai start : injection
   gateway, registry rewrite, et potentiellement h2a alors qu'aucun nouveau
   process Claude n'est lance.
3. Il faut une decision produit explicite : session existante = conflit non-zero
   avec guidance, pas succes idempotent.
4. Le preflight local-session doit preceder guard single-writer, injection et
   spawn.

Findings non bloquants :

- `tmux switch-client` est conceptuellement bon pour `remote attach` depuis
  tmux.
- Le status de `attachLocalSession` doit etre propage.
- Mettre a jour la metadata tmux en reuse est risqué si le process reel ne
  correspond pas au nouveau profile/cwd.

## 7. Non-objectifs de la premiere correction

- Ne pas construire tout de suite le diagnostic complet "pane bash vs Claude".
- Ne pas implementer tout de suite tous les diagnostics fins de `remote resume`
  si D1/D2 ne sont pas encore stabilises.
- Ne pas changer le format des conversations Claude.
- Ne pas modifier les fichiers de configuration Claude.
- Ne pas changer la politique du guard single-writer.

## 8. Revue GPT-5.5 xhigh #2 — amendement `remote resume`

Reviewer : sous-agent `gpt-5.5`, reasoning `xhigh`, lecture seule.

Verdict : amendement coherent, avec precisions bloquantes integrees ci-dessus.

Findings bloquants :

1. `remote resume <slug>` doit definir ses codes de sortie. Decision integree :
   `0` action effectuee, `2` deja actif/no-op attendu, `1` refus/erreur.
2. `--replace` ne doit pas devenir un alias de `remote run --force`. Decision
   integree : writer actif verifie bloque toujours.
3. La mecanique de remplacement doit etre explicite. Decision integree :
   kill/recreate tmux par defaut pour garantir l'heritage de l'env gateway.
4. Registre incomplet ou ambigu : refus bavard, pas de `--continue` devine.

Findings non bloquants :

- Confirmation preferee : phrase exacte `replace <slug>`, pas `y`.
- Employer `replace/relaunch` pour un shell idle prouve ; reserver `takeover`
  aux etats ambigus.
- Re-check obligatoire juste avant action destructive pour eviter une course.
