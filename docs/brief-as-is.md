# Brief initial, as is

ok, je voudrais faire un ensemble d'elements permettant de piloter n'importe quelle cli avec n'importe quelle cli pour du code out tout autre tâche
- backend minimal pour orchestration de sessions à la demande en microconteneus isolés (k8s sur scw ou gcp, filtesystem virtuel persistant pour les sessions de code, orchstration avec le system de secret, ensemble des cli dispo, pop des docker de test de chaque session, et navigateur headerfull pour action de navigation en délégation de l'utilisateur, gestion des confs de session: clis installées - type de cl codex/opencode/claude code/gemini cli et stockage péenne des conversations de session,...) 
- plugin pour une session maitre permettant de toutes les controler (donnr des instructions, drumbeat, suivre l'avancement, gérer d'éventuelles escalades, planifier, configurer et pop les nouveaux env: conf des cli: gh, scw, gcloud, npm, python, ), dont le plan de travail sera suivi en git commit
- plugin pour sessions esclaves (escalation pour install sudo ou demande de validation, besoin 2FA, etc)
- gestionnaire de 2FA, pour accéder aux secrets, et/ou permettre la tierce auth 2FA
- frontend : terminal emulator en swipe sur le portable ou un tab = un env, et proxy UAT (s'il y a un fronent à texter), proxy navigaeur piloté par playwright (2FA pour l'agent ou login qq part pour une action quelconque). fonction vocale pour dicter sur le terminal ce qu'on veut faire (utiliser voxtral-js ma lib publiée pour ça)

stock ça as is stp utilise brainstorm pour initier le projet. on céera tout de suite le projet sur github : rhanka/remote-controle
on commencera par une veille des feature clé de remote controle et trouver des bout de lib à recoder le casé chéant pour certaines fonction (mais je ne veux pas utilise pour ls fonctions clés cités des codes que je ne maitrise pas). aussi, on utilisera du typescript en backend, et svelte 5 en frontend. ah oui, et aussi, on scaffold de façon à publier tout ce qu'on peu en librairie (si possible sur @entropic/... sachant qu'il y a un autre repo qu publie sur @entropic/... d'autres libs, je sais pas si c possible)
