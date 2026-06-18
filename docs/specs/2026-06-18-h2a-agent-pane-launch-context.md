# remote run --h2a: wake target du pane agent

Status: EVOL cadrage
Track: `01KVEB8XX84D4Q32TVYQ2ND87K`
Sources h2a:

- `env:20260618-h2a-remote-wake-target-request`, from `codex:a2a-cli:10ff352a1771`
- `env:20260618-codex-remote-h2a-wake-agent-pane-ack-request`, read from `codex:remote`
- ACK sent: `env:20260618-codex-remote-h2a-wake-agent-pane-ack-reply`

## Finalite

La finalite est que `remote run <profile> --h2a` rende l'agent joignable et reveillable sur le pane tmux de l'agent reel, pas sur la fenetre laterale `h2a`. Un inbox wake h2a doit injecter dans Claude/Codex/Gemini/AGY selon le profil lance, avec un ciblage stable par session.

## Etat courant

- `startLocalSession(profile, ...)` cree une session tmux `remote-<slug>` avec une premiere fenetre nommee par le profil.
- `startH2aWindow(session, cwd, h2a.command)` ajoute une fenetre laterale `h2a`.
- La commande h2a est globale: `h2a mcp-serve --auto-open --auto-upgrade --wake local-tmux`.
- Remote ne transmet aujourd'hui aucun pane agent explicite au side-window.
- Risque actuel: h2a auto-detecte `process.env.TMUX_PANE` depuis le process `mcp-serve` de la fenetre laterale, donc un wake peut viser la fenetre `h2a` au lieu du pane Codex/Claude.

La finalite reste: le wake h2a doit atteindre le pane agent reel.

## Decisions

### D1 - Le v1 se corrige dans remote, sans changer le protocole h2a

Le premier patch doit etre remote-side. Il ne depend pas de `--launch-context-file` et ne change pas `DEFAULT_H2A_COMMAND` en v1.

Raison: le `h2a` global observe localement est `@sentropic/h2a-cli@0.71.0` et son `--help` ne documente pas `--launch-context-file`. Le correctif minimal robuste est donc de fournir a h2a le bon `TMUX_PANE` au moment ou il lance `mcp-serve --wake local-tmux`.

La finalite reste: corriger le wake vers l'agent reel avec le moins de dependance inter-repo possible.

### D2 - Remote capture et persiste le pane agent

`startLocalSession` doit capturer le pane agent juste apres `tmux new-session`, puis le persister sur la session tmux:

- `@remote_agent_pane = %pane_id`
- `@remote_agent_host = <profile>`
- `@remote_agent_cwd = <cwd>`

Pour une session deja existante, remote relit d'abord `@remote_agent_pane`. Si l'option est absente, il tente un fallback sur le premier pane d'une fenetre non `h2a`, puis backfill l'option. Ce fallback ne doit servir qu'aux sessions legacy.

La finalite reste: le side-window h2a ne doit jamais deviner le pane agent a partir de son propre process.

### D3 - `startH2aWindow` injecte `TMUX_PANE=<agent-pane>` dans son wrapper

`startH2aWindow` doit accepter un pane agent resolu et le passer a `buildSessionWindowArgs`. Le wrapper de fenetre doit exporter ce pane avant d'evaluer la commande configuree:

```sh
export TMUX_PANE="$agent_pane"
eval "$cmd"
```

Le point d'implementation prefere est `tmux.ts`:

- helper de resolution/persistence du pane agent;
- extension de `buildSessionWindowArgs(session, windowName, cwd, commandLine, agentPane?)`;
- extension de `startH2aWindow(session, cwd, commandLine, { agentPane, ... })`;
- appels depuis `remote run` et `remote delegate` apres creation de session.

La finalite reste: `h2a mcp-serve --wake local-tmux` voit le pane de l'agent, pas celui de la fenetre `h2a`.

### D4 - Ne pas publier une fausse cible wakeable

Si la fenetre `h2a` existe deja, remote doit avertir que le contexte wake peut etre stale ou faux. Le v1 ne doit pas silencieusement promettre que le side-window existant a ete recable.

Si aucun pane agent ne peut etre resolu et que la commande contient `--wake local-tmux`, remote doit preferer `warning + false` plutot que demarrer h2a avec une cible fausse.

La finalite reste: mieux vaut ne pas annoncer un agent wakeable que reveiller le mauvais pane.

### D5 - Les chemins `remote run` et `remote delegate` partagent le meme contrat

Le bug touche tout lancement interactif tmux avec side-window h2a. Donc le helper doit servir:

- `remote run <profile> [path] --h2a`;
- `remote run` quand `h2a.enabled=true`;
- `remote delegate <profile> <task>` en mode interactif local, qui appelle deja `startH2aWindow`.

Le headless reste hors scope: pas de pane interactif a reveiller.

La finalite reste: un agent interactif lance par remote est reveillable au bon endroit.

### D6 - `--launch-context-file` reste une evolution ulterieure

Le launch-context JSON reste une bonne direction quand h2a expose et documente le flag cote `mcp-serve`, mais il n'est pas le patch v1 ACKe. Le v1 doit d'abord fixer le faux `TMUX_PANE` sans changer la commande par defaut.

La finalite reste: livrer vite le wake correct, puis enrichir le contrat h2a quand la surface est stable.

### D7 - Verification attendue

Tests unitaires:

- `startLocalSession` stocke le pane agent sur la session tmux;
- `startH2aWindow` injecte le pane stocke dans le wrapper;
- le wrapper exporte `TMUX_PANE=%N` avant `eval "$cmd"`;
- fenetre `h2a` deja existante: warning stale/wrong context;
- pane agent introuvable + `--wake local-tmux`: warning + `false`;
- `remote run <profile> --h2a` cable le side-window apres creation de session;
- `remote delegate` local interactif passe par le meme helper.

Test manuel cible:

```sh
remote run codex /repo --name h2a-target --h2a
h2a sessions --root ~/h2a-workspace/.h2a
```

Acceptance:

- le side-window `h2a` tourne avec `TMUX_PANE` egal au pane Codex;
- un inbox wake injecte dans le pane agent;
- deux sessions du meme cwd avec deux noms differents produisent deux panes distincts;
- une fenetre `h2a` preexistante ne masque pas un contexte stale.

La finalite reste: h2a doit reveiller l'agent reel, pas son propre sidecar.

## Double revue 5.5xhigh

### Revue 1 - Correctness/runtime

Finding A: s'appuyer sur le nom de fenetre `codex`/`claude` est fragile, parce que tmux laisse les titres OSC renommer les fenetres. Resolution: enregistrer le pane id en option tmux juste apres creation et l'utiliser comme source principale.

Finding B: une session existante peut avoir ete creee avant l'option `@remote_agent_pane`. Resolution: fallback premier pane non `h2a`, puis backfill de l'option; warning si la fenetre `h2a` existe deja.

Finding C: changer `DEFAULT_H2A_COMMAND` vers `--launch-context-file` en v1 serait premature, car le h2a installe ici ne documente pas ce flag. Resolution: garder la commande par defaut et injecter `TMUX_PANE` dans l'environnement du wrapper.

### Revue 2 - Securite/ops/compatibilite

Finding D: `h2a.command` est une ligne shell custom executee par le wrapper existant; une construction naive peut casser le quoting. Resolution: ne pas reconstruire la commande en v1; seulement exporter un env var controle avant `eval "$cmd"`.

Finding E: publier h2a avec le pane du side-window est pire que ne rien publier: cela cree une fausse cible wakeable. Resolution: si `--wake local-tmux` est actif et que le pane agent est introuvable, `startH2aWindow` doit avertir et retourner `false`.

Finding F: le side-window ne doit jamais devenir l'autorite d'exclusion ou de session lifecycle. Resolution: le pane env est uniquement une adresse de wake; remote garde la supervision tmux/registry existante.

## Hors scope

- Changer le protocole h2a ou implementer `--launch-context-file` cote h2a.
- Revoir la strategie globale de presence/keepalive.
- Resolver l'item separe `Ctrl+V image dans tmux : OK sur claude, KO sur codex`.
- Modifier la migration local/remote ou le controle anti split-brain.

La finalite reste: corriger le ciblage du wake h2a pour les agents interactifs lances par remote.
