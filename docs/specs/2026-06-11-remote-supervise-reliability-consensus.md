# remote supervise — fiabilité (rate-limit / auth / drift)

Statut : **consensus opus 4.8 + Fable 5** (raisonnement conjoint). Design, pas encore code.
Date : 2026-06-11. Source des 3 douleurs : product owner (jobs qui stallent sur rate-limit ;
gh/claude/npm/docker qui se délogguent en pod ; MCP/plugins pod pas à jour).

## Thèse unifiante
Les 3 sont la même forme : **état désiré local + diff périodique + converge idempotente**, et
partagent le *failure-mode zéro* : « le watcher ne tournait pas » (éclaté aujourd'hui en
`creds refresh --watch`, `jobs conduct --watch`, `conductor-launch --watch`, `h2a bridge --watch`).
→ **une commande `remote supervise [--watch <min>]`** qui compose des passes **ordonnées** :
**(1) creds → (2) drift → (3) jobs**. Réutilise le squelette `conductLoop` (foreground tmux +
systemd user unit, pas de daemon/pidfile). Le timer systemd creds-watch est repointé dessus ;
`jobs conduct` et `creds refresh --watch` restent en alias (1 passe, back-compat). Chaque passe =
**planner pur + exécuteur fin** (style `planNextStarts`/`reconcileRemoteJobs`, testable sans
tmux/kubectl). Heartbeat par passe → advisory rouge dans `ls`/`jobs ls` si périmé (extension de
`conductorAdvisory`). Ordre justifié : creds d'abord (sinon un pane 401 est lu comme un stall, et
un job repris a besoin d'auth valide) ; drift avant l'admission (un job remote atterrit sur un pod
convergé).

## 1. Rate-limit qui stalle les jobs
**Failure mode** : `reconcileJobState` ne lit que la *liveness* ; un claude qui a imprimé
`API Error: Server is temporarily limiting requests … Rate limited` est *vivant* → reste `running`
à jamais. Headless : exit≠0 → `failed`, indiscernable d'un vrai échec, aucun retry.
**Détection = 2 signaux** (jamais la signature seule — l'agent peut *citer* l'erreur) :
- **A — table de signatures** (`throttle-signatures.ts`, regex par outil, versionnée+testée, scan
  tail 60 lignes) : claude `temporarily limiting requests|rate.?limit|429|overloaded`, codex
  `Rate limit reached`, etc.
- **B — stall** : `localSessionIdle()` vrai, OU hash du tail inchangé depuis la passe précédente,
  OU (headless) exit≠0 + signature dans le tail d'`output.log`.
  Local : `capturePane`. Remote phase 1 : `kubectl exec … tmux capture-pane` (plomberie
  `soft-refresh.ts`). Phase 2 : détection dans le session-agent → event WS `session.throttled`.
**Recovery** : nouvel état **`throttled`** (`running→throttled→running|failed`), affiché dans
`jobs ls` (`throttled (retry in 4m)`). Auto-resume **full-jitter** (formule `jitteredDelay` du
WS) base 60 s, cap 30 min, **6 tentatives → failed reason=rate-limited**. Resume : headless →
relaunch `claude -p --continue` / `codex exec resume --last` dans le même `runCwd` ; interactif
pane idle → `relaunchInSession`; **jamais `send-keys` dans un pane attaché par un humain**
(`session_attached==0` requis). **Circuit-breaker AIMD dans le conductor** : le throttle est
*account-wide* → si ≥2 jobs `throttled` en 10 min, **halve** la cap effective de `planNextStarts`,
resume échelonné (1 par passe, le plus vieux d'abord), +1 slot par passe propre. Les `throttled`
**gardent leur slot**. Pas de queue ni daemon nouveaux : une étape de plus dans la passe.

## 2. Auth qui se délogue en pod
**4 gaps concrets** : (1) **couverture** — le watcher refresh seulement le CLI du profil ;
gh/scw/aws bundlés *une fois* à la création ; **npm et docker pas même dans `TOOL_AUTH`**
(tokens registry horaires → 401 garanti) ; (2) **push-only gated-sur-changement-local** —
`hashAuthBundle` no-op si le fichier local est inchangé, donc on pousse (ou skip) un token
**périmé** sans regarder `expiresAt` ; (3) **race de rotation** — le token claude tourne à l'usage ;
le pod peut s'auto-refresh (token *plus récent*), et la passe suivante voit « local≠pod » et
**écrase le token récent du pod par l'ancien local** → 401 des deux côtés ; (4) **liveness du
watcher non observée** — laptop endormi/loop crashée = pas de refresh et **pas d'alarme**, aucun
backstop pod-side.
**Mécanisme — modèle `CredSpec` unifié, 3 couches, newest-wins** (`creds-model.ts` fusionnant
`TOOL_AUTH`/`PROFILE_AUTH_FILES`), par outil `{files[], probe, expiry?, localRefresh?}` —
**ajouter npm + docker en first-class** :
1. **Push sur changement local (fast path)** : `fs.watch`/inotify sur les `files` (debounce 2 s)
   remplace le poll 15 min (poll gardé en fallback).
2. **Refresh proactif pré-expiration** : parse `expiry` (claude `expiresAt`, docker TTL) ; à T-15 min
   `localRefresh` (ou « lance `gh auth login` » bruyant) puis push. Stoppe l'envoi de tokens morts.
3. **Backstop pull pod-side (401)** : le session-agent run le `probe` de chaque outil /5 min, écrit
   `~/.remote-cred-health.json` + émet `cred.health{tool,ok,reason}` (phase 1 `kubectl exec cat`,
   phase 2 WS). Le superviseur pousse le bundle de l'outil immédiatement → **rattrape tout** ce que
   le push a raté (y compris « watcher mort 3 h »).
**Règle de conflit (tue le gap 3)** : avant d'écraser, comparer la fraîcheur — claude `expiresAt`
(pod plus récent → **pull vers local** au lieu d'écraser) ; autres : mtime dans le hash-file pod.
**Jamais pousser ancien-sur-récent.** Ownership : CLI local = vérité+push ; session-agent =
probe+report ; control-plane = relais (creds ne vivent jamais au-delà du Secret par-session).

## 3. Drift plugin/MCP remote↔local
**Failure mode** : l'état désiré existe (`plugins[]` `pkg@version`, `mcp[]`, skills) mais la
convergence est **impérative et amnésique** : `plugin sync` = push manuel vers les pods *vivants* ;
un restart de pod perd les globals npm ; **les nouvelles sessions démarrent non-convergées** ;
`pluginLs` affiche `REMOTE ?`.
**Mécanisme** : **manifeste d'état désiré** (config locale → JSON canonique + sha256, poussé en
`~/.remote-manifest.json`+`.sha256`, même gating que `CREDS_HASH_FILE`) ; **converge au démarrage de
session** (le session-agent run `buildPodSyncScript` contre le manifeste **avant** de lancer le
CLI — tue la source #1 de drift : pods frais/redémarrés) ; **détection de drift dans la passe**
(compare hash local vs pod, re-sync le delta) ; verify profond hebdo/`--check` (`npm ls -g --json`
+ grep MCP, car le hash-file peut mentir après un `npm i -g` manuel) ; **`remote plugin sync
--check`** = rapport de drift (pod × plugin × {ok|version-drift|missing|mcp-unregistered}), exit 1
sur drift — remplace `REMOTE ?`. Bake Dockerfile en belt-and-braces, mais c'est la boucle qui rend
le drift *observable*.

## Réconciliation (ajouts opus au design Fable 5)
- **Séquencer par risque, pas tout d'un coup.** Ordre de livraison : (a) rate-limit
  **visibilité + auto-resume headless + breaker** [slice 1, zéro risque pane] ; (b) creds
  **backstop pull 401 pod-side + couverture npm/docker + heartbeat advisory** [haute valeur, bas
  risque] ; (c) drift **converge-on-start + `--check`** [moyen] ; **différer** le newest-wins/
  pull-back creds (risque #2) **derrière du dry-run logging** ; le `send-keys` resume interactif est
  le plus risqué → garde dure (`session_attached==0`) ou différé.
- **Visibilité d'abord** : même avant l'auto-resume parfait, afficher `throttled` dans `jobs ls`
  transforme « stall silencieux » en « throttled visible + retry » — gain minimal immédiat.
- Le backstop pull 401 pod-side est le **meilleur ratio valeur/risque** des creds (rattrape tout,
  quelle que soit la raison du raté push).

## Risques (top 3)
1. **Faux positif throttle** (signature citée, scrollback périmé) → tail-only + corroboration stall
   obligatoire + jamais sur pane attaché + `throttled` réversible (output frais → re-`running`).
2. **Clobber de credential** via newest-wins bugué (pire qu'aujourd'hui) → champs de fraîcheur
   par-outil + pull-back claude + dry-run logging 1 semaine avant d'activer ; Secret patch reste le
   fallback durable.
3. **Superviseur SPOF/interférent** → chaque action idempotente + garde pane-attaché + ligne de
   journal par converge + heartbeat advisory (« superviseur down » bruyant) + systemd
   `Restart=on-failure`.

## 1ère slice (de-risk maximal)
**Throttle headless local claude/codex + breaker AIMD** (pain #1 = rien aujourd'hui, signal le plus
propre : exit≠0 + signature dans le tail d'`output.log`) :
1. `throttle-signatures.ts` (pur, testé) + état `throttled` + champs registry
   `throttle{attempts,firstAt,nextRetryAt,lastSignature}`.
2. Passe conductor : un job headless fini est classé `throttled` (pas `failed`) si signature ;
   resume `claude -p --continue`/`codex exec resume --last` dans le même `runCwd`, full-jitter
   (60 s→30 min, 6 tentatives).
3. Breaker AIMD sur la cap effective de `planNextStarts` ; `jobs ls` montre `throttled (retry in 4m)`.
Pose la machine à états + le helper backoff + la structure de passe où les slices 2 (probes creds) et
3 (hash manifeste) se branchent — zéro pane interactif, zéro changement de protocole.
