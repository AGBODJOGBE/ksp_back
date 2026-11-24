# Planification automatique (lot G)

Domaine pur de la planification automatique (cahier des charges Nettoyage v2, 9.5, R-PL-01 à
R-PL-07). Aucune horloge implicite ni aléa : l'heure (`context.now`), les agents et leur agenda relu
sous verrou, les séances et les réglages sont fournis par l'appelant. Les contrôles sont ceux de la
planification manuelle (`../planning`) : `checkTarget` pour chaque équipe essayée, `planAssignments`
pour la validation des propositions, `agendaEntriesFor` pour occuper l'agenda au fil du passage.
Aucun contrôle n'est contourné.

| Fichier            | Rôle                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `score.ts`         | Score d'un candidat (R-PL-03) : continuité, proximité, équilibre, note            |
| `modes.ts`         | Mode d'une zone (R-PL-05), période d'un passage (R-PL-01), cibles et leur ordre   |
| `team-choice.ts`   | Candidats (R-PL-02), équipes essayées, chef d'équipe (R-PL-04), motif d'échec     |
| `auto-planning.ts` | Passage : propositions ou affectations, agenda mis à jour séance après séance     |
| `report.ts`        | Rapport du passage : séances pourvues, séances restées à affecter et leurs motifs |
| `approval.ts`      | Validation des propositions (ApproveProposals), contrôles refaits                 |

## Matrice règle → test

| Règle                            | Code ou issue                                             | Cas nominal                                                                                          | Cas limite                                                                                                               |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| R-PL-01 Période et horizon       | `CLEANING_VALIDATION_FAILED` (`to`)                       | `modes.spec` « de maintenant à maintenant + horizon »                                                | « fin qui n'est pas après le début », « période semi-ouverte », « début fourni sans fin »                                |
| R-PL-01 Cibles                   | —                                                         | `modes.spec` « une séance à affecter, à venir »                                                      | « séance planifiée, visite, ou début égal à maintenant », filtres de zone et de programme                                |
| R-PL-02 Filtre, jamais forcé     | `no_candidate`                                            | `team-choice.spec` « un agent qui passe tout »                                                       | « hors zone ou hors plages : jamais forcé », « en congé ou suspendu » ; `auto-planning.spec` « seul candidat hors zone » |
| R-PL-03 Poids                    | —                                                         | `score.spec` « continuité 40, proximité 25… »                                                        | « un poids à 0 annule son critère »                                                                                      |
| R-PL-03 Continuité (graduée)     | —                                                         | `score.spec` « agent venu à chaque séance réalisée »                                                 | « jamais venu », « sans séance réalisée », « reprend la main » ; `auto-planning.spec` « autre programme »                |
| R-PL-03 Proximité, R-ZN-02       | —                                                         | `score.spec` « même lieu, trajet nul », « le trajet réduit »                                         | « 60 min ou plus », « la veille, finie à minuit pile », « retirée ou postérieure », « hors zone »                        |
| R-PL-03 Équilibre                | —                                                         | `score.spec` « aucune heure ; 24 h »                                                                 | « 48 h ou plus », « semaine ISO à Porto-Novo », « le trajet ne compte pas »                                              |
| R-PL-03 Note                     | —                                                         | `score.spec` « 5 étoiles ; 1 étoile »                                                                | « agent sans note »                                                                                                      |
| R-PL-04 Meilleurs scores         | `team_incomplete`                                         | `team-choice.spec` « les deux meilleurs scores »                                                     | « places manquantes seulement », « moins de candidats que de places », compétences, « essais bornés »                    |
| R-PL-04, R-EQ-03 Chef d'équipe   | `no_lead`                                                 | `team-choice.spec` « le mieux noté des aptes »                                                       | « aucun apte parmi les meilleurs », « aucun apte du tout », « un seul agent, ou un chef déjà en place », départage       |
| R-PL-05 Modes                    | `proposed`, `confirmed`, `pending_confirmation`           | `modes.spec` « le mode de la zone remplace » ; `auto-planning.spec` « proposition », « automatique » | « zone sans mode » ; `auto-planning.spec` « zone en mode manuel »                                                        |
| R-PL-05 Validation               | `CLEANING_AGENT_ON_LEAVE`, `CLEANING_INVALID_TRANSITION`  | `approval.spec` « salarié confirmé, indépendant en attente »                                         | « en congé depuis la proposition », « début passé », « déjà retirée », « attente échue », « un membre pris ailleurs »    |
| R-PL-06 Échec et alerte          | `no_candidate`, `team_incomplete`, `no_lead`              | `report.spec` « cibles impossibles : motif… »                                                        | « passage sans séance : aucune alerte »                                                                                  |
| R-PL-07 Stabilité, trous         | —                                                         | `auto-planning.spec` « l'agent déjà pris garde son affectation »                                     | « séance déjà en partie pourvue », « séance pleine ou déjà planifiée »                                                   |
| R-PL-08 Statut à l'écriture      | `pending_confirmation`                                    | `auto-planning.spec` « confirmée d'office… en attente 12 h »                                         | `approval.spec` échéance comptée depuis la validation                                                                    |
| R-PL-11 Agenda au fil du passage | `CLEANING_SCHEDULE_CONFLICT`, `CLEANING_AGENT_OVERLOADED` | `auto-planning.spec` « bout à bout : même agent, trajet nul »                                        | « 10 min d'écart », « trajet juste suffisant », « deux séances simultanées », « la charge cumule »                       |
| Continuité au fil du passage     | —                                                         | `auto-planning.spec` « l'équipe de la première séance est gardée »                                   | « un membre en congé est remplacé ce jour-là, puis l'équipe revient »                                                    |
| Déterminisme                     | —                                                         | `auto-planning.spec` « mêmes entrées dans un autre ordre »                                           | `score.spec` « identifiants comparés par points de code » ; `lot-g.spec` « déterministe »                                |
| Critère du lot G (partie 18)     | —                                                         | `lot-g.spec` « toutes les séances possibles sont affectées », « aucun conflit », « même équipe… »    | « un membre absent est remplacé ce jour-là seulement » ; « performance : moins d'une seconde »                           |

## Interprétations prudentes (isolées dans une fonction ou une constante nommée)

- `proximityFactor` : hors zone, 0 ; dans la zone sans affectation ce jour-là, 1 ; sinon le facteur
  décroît avec le trajet compté avant la séance, jusqu'à 0 à `PROXIMITY_ZERO_MINUTES` (60 min).
- `hasPreviousSameDay` : « ce jour-là » = affectation en vigueur commencée le même jour (Porto-Novo)
  et finie au plus tard au début de la séance.
- `balanceFactor` : heures de la semaine ISO, cible seule, rapportées à `BALANCE_REFERENCE_HOURS`
  (48 h), la même pour tous les agents.
- `ratingFactor` : un agent sans note reçoit le milieu de l'échelle (3 étoiles).
- `continuityFactor` et `AutoPlanningInput.programHistory` : gradué (décision du responsable), pour
  que l'agent habituel reprenne la main après un remplaçant d'un jour : part des séances réalisées du
  programme faites par l'agent ; à défaut de séance réalisée, part des séances couvertes par ses
  affectations en vigueur. Les équipes retenues par le passage comptent pour les séances suivantes du
  même programme (`withRetainedTeam`).
- `runMode` : un passage qui couvre plusieurs zones rend le mode le plus prudent, `proposal` dès
  qu'une séance traitée est en mode proposition.
- Ordres communs (`compareIds`, `comparePlanningOrder`) : exportés par `../planning/order.ts`.
- `compareLeadCandidates` : « le mieux noté » = la note moyenne des clients ; noté avant non noté,
  puis le score, puis l'identifiant.
- `chooseTeam` : équipes essayées dans l'ordre lexicographique des rangs (le moins bien classé est
  remplacé d'abord) pour couvrir les compétences et trouver un chef, au plus `MAX_TEAM_ATTEMPTS`.
- `effectiveMode` : la zone d'une séance est la commune de son lieu.
- `planningWindow` : sans fin, l'horizon court depuis le début demandé.
- `isAutoPlannable` : seules les séances « à affecter » sont traitées, jamais les visites.
- `autoAssignmentState` : une proposition est « proposed » sans échéance ; l'échéance de
  l'indépendant part de la validation.
- `approveProposals` : les propositions d'une même séance sont validées ensemble ou ignorées
  ensemble ; une ligne qui n'est plus « proposed » est ignorée seule.
