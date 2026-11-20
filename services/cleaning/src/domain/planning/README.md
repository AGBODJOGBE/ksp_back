# Planification (lot D)

Domaine pur des agents et de la planification manuelle (cahier des charges Nettoyage v2, partie 9).
Aucune horloge implicite : l'heure est toujours passée en argument (`now`). Les temps de trajet sont
fournis par l'appelant (`TravelTime`, ou `travelFromMatrix` sur une matrice déjà calculée par geo).
Les codes d'erreur sont ceux du contrat (`errors.ts`) ; l'adaptateur les traduit en `AppError`.

| Fichier                | Rôle                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `../agents/agent.ts`   | Statuts d'un agent (15.2), compétences validées, désactivation                      |
| `assignment-status.ts` | Statut d'une affectation, statut effectif d'après l'heure, réponse de l'indépendant |
| `time.ts`              | Périodes semi-ouvertes, jour, jour de semaine et semaine ISO à Porto-Novo           |
| `agenda.ts`            | Temps de trajet (R-ZN-02) et contrôle « Aucun conflit »                             |
| `availability.ts`      | Disponibilités, indisponibilités, charge, plages occupées                           |
| `assignment-check.ts`  | Tous les contrôles d'une cible, équipe, chef d'équipe, taille                       |
| `assignment-batch.ts`  | Affectation en lot et contrôles de la demande                                       |
| `staffing-alert.ts`    | Alerte d'une séance sans agent, annulation faute d'agent                            |
| `release.ts`           | Libération de l'agenda à la sortie d'une cible                                      |

## Matrice règle → test

| Règle                                        | Code ou issue                                                            | Cas nominal                                                                                  | Cas limite                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 15.2 Agent                                   | `CLEANING_INVALID_TRANSITION`                                            | `agent.spec` « chaque transition de 15.2 est permise »                                       | « toute autre transition… », « cas limites : candidat refusé sans vérification… »                               |
| 9.1 Refus motivé                             | `CLEANING_REASON_REQUIRED`                                               | `agent.spec` « un refus exige un motif » (avec motif)                                        | même test : motif vide ou blanc                                                                                 |
| R-AG-01 Compétences validées                 | —                                                                        | `agent.spec` « seules les compétences validées comptent »                                    | « aucune compétence validée » ; `assignment-check.spec` « déclarée mais non validée ne compte pas »             |
| R-AG-01 Agent actif                          | `CLEANING_AGENT_NOT_ACTIVE`                                              | `assignment-check.spec` « cas nominal »                                                      | « tous les motifs » (agent suspendu, non contournable)                                                          |
| R-AG-03 Désactivation                        | `CLEANING_AGENT_HAS_ASSIGNMENTS`                                         | `agent.spec` « sans affectation à venir »                                                    | « en cours comprise » (fin = maintenant + 1 s), « réaffectation automatique »                                   |
| R-AG-03 Suspension                           | affectations à venir retirées                                            | `agent.spec` « retire les affectations à venir »                                             | « sans affectation à venir »                                                                                    |
| R-AG-03 Affectation à venir                  | —                                                                        | `assignment-status.spec` « à venir… »                                                        | fin = maintenant : passée                                                                                       |
| R-CA-09 Compétences de l'équipe              | `CLEANING_SKILL_MISSING`                                                 | `assignment-check.spec` « deux agents qui se complètent », « agents déjà affectés »          | « critère du lot D : un agent sans la compétence est refusé » ; `assignment-batch.spec` même critère            |
| R-ZN-02 Trajet                               | —                                                                        | `agenda.spec` « lieux différents : temps calculé »                                           | « même lieu : 0, sans calcul », « calcul indisponible : valeur par défaut »                                     |
| 9.4 Aucun conflit                            | `CLEANING_SCHEDULE_CONFLICT`                                             | `agenda.spec` « trajet juste suffisant »                                                     | « fin = début de la suivante », « insuffisant d'une minute », « trajet déjà enregistré »                        |
| Lot D, deux superviseurs                     | `CLEANING_SCHEDULE_CONFLICT`                                             | `assignment-batch.spec` « le premier superviseur affecte »                                   | « le second est refusé », bornes fin = début, trajet juste suffisant / insuffisant, fuseau Africa/Porto-Novo    |
| 9.4 Zone                                     | `CLEANING_AGENT_OUT_OF_ZONE`                                             | `assignment-check.spec` « cas nominal »                                                      | « contournés avec motif » ; `assignment-batch.spec` « contournement sans motif »                                |
| R-DS-01 Disponibilité                        | `CLEANING_AGENT_UNAVAILABLE`                                             | `availability.spec` « tient exactement dans une plage »                                      | « une minute avant / après », plages contiguës, minuit, UTC / Porto-Novo                                        |
| R-DS-02 Disponibilité exceptionnelle         | —                                                                        | `availability.spec` « complète ou remplace le modèle »                                       | même test : une seconde de trop                                                                                 |
| R-DS-02 Indisponibilité déclarée             | `CLEANING_AGENT_ON_LEAVE`                                                | `availability.spec` « toute indisponibilité qui chevauche »                                  | « fin du congé = début » ; `assignment-check.spec` « jamais contourné, même avec motif », « trajet compris »    |
| R-DS-03 Charge                               | `CLEANING_AGENT_OVERLOADED`                                              | `availability.spec` « 6 h + 2 h = 8 h »                                                      | « une minute de trop », semaine ISO, séance à cheval sur minuit ; `assignment-batch.spec` charge cumulée du lot |
| Trajet hors charge et disponibilité          | —                                                                        | `assignment-check.spec` « le trajet ne compte ni dans la disponibilité ni dans la charge »   | même test : une minute de trajet de trop, seul le conflit échoue                                                |
| R-DS-04 Indisponibilité sur des affectations | `CLEANING_UNAVAILABILITY_CONFLICT`                                       | `availability.spec` « refusée avec la liste »                                                | « fin = début du trajet », « forcée par le superviseur »                                                        |
| R-DS-05 Plage occupée                        | `CLEANING_AVAILABILITY_IN_USE`                                           | `availability.spec` « garde les affectations »                                               | « l'agent retire une plage occupée », « le superviseur peut »                                                   |
| 9.4 Taille d'équipe                          | `CLEANING_TEAM_SIZE_MISMATCH`, alerte `team_size_short`                  | `assignment-check.spec` « cas nominal »                                                      | « plus d'agents que prévu », « moins, forcé », « visite »                                                       |
| 9.4 Contournement                            | `CLEANING_REASON_REQUIRED`                                               | `assignment-check.spec` « contournés avec motif »                                            | `assignment-batch.spec` « contournement sans motif » ; « sur un contrôle qui passe »                            |
| R-EQ-02 Équipe                               | `CLEANING_TEAM_INACTIVE`, membres signalés                               | `assignment-check.spec` « les membres retenus… » ; `assignment-batch.spec` « équipe active » | « aucun membre actif et disponible », « membre déjà affecté », « équipe désactivée »                            |
| R-EQ-03 Chef d'équipe                        | `CLEANING_VALIDATION_FAILED` (`leadAgentId`), alerte `team_lead_missing` | `assignment-check.spec` « un agent seul »                                                    | « plus d'un agent sans chef », « chef hors des agents », « second chef », « chef de l'équipe indisponible »     |
| R-PL-06 Alerte 48 h                          | `unassigned_48h`                                                         | `staffing-alert.spec` « exactement 48 h avant »                                              | « plus de 48 h avant », lecture en instants UTC                                                                 |
| R-PL-08 Indépendant                          | `pending_confirmation`, `CLEANING_INVALID_TRANSITION`                    | `assignment-status.spec` « salarié / indépendant », « accepte ou refuse »                    | échéance incluse, « au plus tard au début de la cible », « refusé après l'échéance », « hors attente »          |
| R-PL-09 Affectations en vigueur              | —                                                                        | `assignment-status.spec` « en vigueur »                                                      | « attente échue » ; `agenda.spec` « ignorées », « proposition et attente occupent l'agenda »                    |
| R-PL-09 Libération de l'agenda               | affectations `removed`, motif système                                    | `release.spec` « en vigueur retirées » ; « s'arrête à la fin réelle »                        | « attente échue » ; « garde 1 min »                                                                             |
| R-PL-10 Cible passée                         | `CLEANING_INVALID_TRANSITION` (`target_in_past`)                         | `assignment-check.spec` « une milliseconde après : accepté »                                 | début = maintenant : refusé                                                                                     |
| R-PL-10 Sans agent à l'heure                 | `unassigned_at_start`, annulation `no_agent`                             | `staffing-alert.spec` « à l'heure de début »                                                 | fin prévue moins une seconde / pile                                                                             |
| R-PL-10 Agent absent                         | `agent_absent`                                                           | `staffing-alert.spec` « à 1 h pile »                                                         | 59 min 59 s ; séances démarrées ou closes                                                                       |
| R-PL-10 Une alerte par niveau                | —                                                                        | `staffing-alert.spec` « pas encore envoyé »                                                  | « déjà envoyé ou inférieur »                                                                                    |
| R-PL-11 Lot                                  | tout ou rien, `skipFailing`                                              | `assignment-batch.spec` « chaque cible occupe l'agenda »                                     | « skipFailing », « sans aucune cible retenue », ordre stable à début égal                                       |
| R-PL-11 Agent effectif                       | `CLEANING_VALIDATION_FAILED` (`agentIds`)                                | `assignment-batch.spec` « aucun agent ni équipe »                                            | `assignment-check.spec` équipe sans membre disponible                                                           |
| 15.2 Cible affectable                        | `CLEANING_PROGRAM_SUSPENDED`, `CLEANING_INVALID_TRANSITION`              | `assignment-check.spec` « séance déjà planifiée »                                            | séance suspendue, terminée, visite annulée, agent déjà sur la cible                                             |

## Interprétations prudentes (isolées dans une fonction ou une constante nommée)

- `AGENT_TRANSITIONS` : tableau de 15.2 mis à jour par la décision du 20 novembre 2026 ;
  « candidat → refusé » et « actif → désactivé » sont permis.
- `suspensionRelease` : la suspension retire les affectations à venir (même règle que la
  désactivation avec réaffectation) ; le contrat n'a pas d'option `reassign` sur la suspension, elle
  n'est donc jamais refusée pour ce motif.
- `initialAssignmentStatus` : échéance de l'indépendant = min(maintenant + délai réglé, début de la
  cible), décision du 20 novembre 2026.
- `travelNeededBefore` : avant une affectation qui suit, le battement est le plus long du trajet réel
  et du trajet déjà enregistré, que la base compte encore (`assignments_no_overlap`).
- `scheduleConflicts` : le trajet avant la cible part de l'affectation qui finit le plus tard avant
  son début ; à égalité, le plus long.
- `unavailabilityWindow` : une indisponibilité se contrôle sur la période occupée, trajet compris.
- `workedPeriod` : la charge compte la cible seule, sans le trajet ; la disponibilité se contrôle
  de même sur la cible seule. Le trajet ne compte que dans le conflit (décision du 20 novembre 2026).
- `targetPreconditions` : un début égal à maintenant est passé ; une séance reçoit des agents en
  `to_assign` ou `assigned`, une visite en `scheduled`.
- `chooseLead` : au-delà d'un agent, le chef est exigé pour des agents désignés ; pour une équipe dont
  le chef est écarté, l'affectation passe avec l'alerte `team_lead_missing`.
- `checkTarget` (mode équipe) : un membre est « disponible » s'il passe, ou voit contourner, tous ses
  contrôles individuels ; compétences et taille d'équipe se jugent sur l'équipe réunie.
