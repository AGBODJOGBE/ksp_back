# Séances (lot E)

Exécution d'une séance sur le terrain (cahier des charges Nettoyage v2, partie 10), reports et
annulations (partie 12). Domaine pur : l'heure est toujours passée en argument (`now`), les instants
sont en UTC et les jours se lisent à Porto-Novo. Les refus portent le code du contrat
(`ExecutionRuleError`, `errors.ts`, partagé avec `programs/` et `payments/`).

| Fichier             | Rôle                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `errors.ts`         | Codes du contrat, transition interdite, motif obligatoire, valeur refusée   |
| `session-status.ts` | Transitions de 15.2, celles réservées au back-office (R-EX-08)              |
| `session.ts`        | Séance de terrain ; agents affectés et chef d'équipe (R-EX-01, R-EQ-03)     |
| `field-time.ts`     | Heure réelle hors connexion, avance maximale à l'arrivée, attente du client |
| `arrival.ts`        | Distance au lieu, alerte et alerte « incertaine », position envoyée         |
| `field-steps.ts`    | Arrivée, photos « avant » et « après », démarrage, liste de contrôle        |
| `field-outcomes.ts` | Incident et reprise, clôture, client absent                                 |
| `staff-closure.ts`  | Réalisation ou absence enregistrées par le back-office (R-EX-08)            |
| `cancellation.ts`   | Annulation par le client, par KSP ou le support, faute d'agent (SES-01)     |
| `reschedule.ts`     | Report par le client ou par KSP, plafond mensuel, agents recontrôlés        |
| `testing.ts`        | Séance du lundi 23 novembre 2026, 9 h – 11 h à Porto-Novo                   |

## Matrice règle → test

| Règle                     | Code ou issue                                         | Cas nominal                                             | Cas limite                                                                    |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 15.2 Séance               | `CLEANING_INVALID_TRANSITION`                         | `session-status.spec` « %s → %s est permise »           | « toute autre transition », séance close ou suspendue                         |
| R-EX-01 Agents affectés   | `CLEANING_SESSION_NOT_FOUND`                          | `session.spec` « un agent affecté agit »                | agent désaffecté ou inconnu                                                   |
| R-EQ-03 Chef d'équipe     | `CLEANING_TEAM_LEAD_ONLY`                             | `session.spec` « chef d'équipe : accepté »              | « un agent seul conduit sa séance »                                           |
| R-EX-05 Heure réelle      | `CLEANING_VALIDATION_FAILED` (`in_future`, `too_old`) | `field-time.spec` « présente et passée : gardée »       | maintenant pile / + 1 ms ; 72 h pile / + 1 ms                                 |
| Partie 10 Avance          | `CLEANING_SESSION_TOO_EARLY`                          | `field-time.spec` « 30 min avant pile »                 | 30 min et 1 s ; UTC / Porto-Novo ; 0 = pas de contrôle                        |
| Partie 10 Position        | alerte, `uncertain`                                   | `arrival.spec` « 300 m pile : pas d'alerte »            | 301 m ; somme des précisions 301 / 300 ; sans position ; précision inconnue   |
| Partie 10 Arrivée         | arrivée gardée                                        | `field-steps.spec` « 30 min avant pile »                | 31 min, hors connexion ; seconde arrivée ; séance en cours                    |
| Partie 10 Photos          | `CLEANING_PHOTO_LIMIT_REACHED`, `photo_kind_conflict` | `field-steps.spec` « photo avant », « photo après »     | 10 photos pile / 11e ; doublon sans effet ; fichier d'un autre type           |
| Partie 10 Démarrage       | `CLEANING_PHOTOS_MISSING`                             | `field-steps.spec` « la séance passe en cours »         | sans photo ; avant l'arrivée / égale ; non chef ; à affecter                  |
| R-PP-04 Séance en retard  | `CLEANING_SESSION_OVERDUE_PAYMENT`                    | `field-steps.spec` « séance précédente en retard »      | voir `payments/start-gate.spec`                                               |
| R-EX-09 Liste de contrôle | `CLEANING_VALIDATION_FAILED` (`not_applicable`)       | `field-steps.spec` « heure réelle gardée »              | cocher deux fois, décocher ; même code d'un autre type ; hors séance en cours |
| Partie 10 Incident        | `interrupted`                                         | `field-outcomes.spec` « tout agent interrompt »         | note vide ; photos au-delà du maximum ; séance pas démarrée                   |
| R-EX-03 Hors devis        | `amendmentRequired`                                   | `field-outcomes.spec` « un avenant »                    | autre catégorie : pas d'avenant                                               |
| Partie 10 Reprise         | `in_progress`                                         | `field-outcomes.spec` « reprise par le superviseur »    | seconde reprise refusée ; seul l'incident en attente est décidé               |
| Partie 10 Clôture         | `CLEANING_CHECKLIST_INCOMPLETE`                       | `field-outcomes.spec` « liste complète »                | un point manquant ; sans photo « après » ; avant le démarrage ; interrompue   |
| R-EX-02 Client absent     | `CLEANING_WAIT_TIME_NOT_ELAPSED`                      | `field-outcomes.spec` « après 30 min d'attente pile »   | 1 s trop tôt ; arrivé en avance ; sans photo ; appel après ; accès impossible |
| R-EX-08 Back-office       | `CLEANING_REASON_REQUIRED`, `presentAgentIds`         | `staff-closure.spec` « réalisée sans photo ni liste »   | fin = maintenant / + 1 ms ; fin = début ; avance ; absence à l'heure pile     |
| Partie 12 Annulation      | `CLEANING_CANCELLATION_TOO_LATE`                      | `cancellation.spec` « 24 h avant pile : annulée »       | 24 h − 1 s ; UTC / Porto-Novo ; séance suspendue, démarrée, interrompue       |
| Partie 12 Support         | cause `customer_late`, `late`                         | `cancellation.spec` « annulation tardive, 50 % dus »    | encore dans le délai : sans frais ; interrompue ou suspendue : refusée        |
| Partie 12 KSP             | cause `ksp`                                           | `cancellation.spec` « motif obligatoire, rien à payer » | interrompue, suspendue ; motif vide ; en cours                                |
| SES-01 Sans agent         | cause `no_agent`                                      | `cancellation.spec` « à la fin prévue pile »            | 1 s avant ; séance planifiée                                                  |
| R-RP-01 Client            | `CLEANING_LEAD_TIME_TOO_SHORT`, `RESCHEDULE_OVERLAP`  | `reschedule.spec` « nouvelle date libre »               | 24 h pile / − 1 s ; fin = début d'une autre ; séance annulée ignorée          |
| Partie 12 Plafond         | `CLEANING_RESCHEDULE_LIMIT_REACHED`                   | `reschedule.spec` « le troisième est refusé »           | mois civil de Porto-Novo (31 octobre 23 h 30 UTC = 1er novembre)              |
| R-RP-01 KSP               | `CLEANING_SLOT_INVALID` (`in_past`)                   | `reschedule.spec` « dans le futur, même proche »        | maintenant pile ; durée 15 / 1 440 / 14 / 1 441 min ; interrompue, suspendue  |
| R-RP-01 Suspendu          | `CLEANING_PROGRAM_SUSPENDED`                          | `reschedule.spec` « programme suspendu »                | séance suspendue après la reprise : reportable                                |
| R-RP-01 Agents            | agents gardés ou retirés                              | `reschedule.spec` « équipe incomplète »                 | tous passent                                                                  |

## Interprétations prudentes (isolées dans une fonction nommée)

- `assertTeamMember` : un agent seul sur sa séance en est le chef.
- `customerAbsentFrom` : l'attente du client ne compte qu'à partir de l'heure prévue.
- `isUncertainAlert` : seule une alerte peut être « incertaine » ; une précision inconnue compte 0.
- `arriveAtSession` : une seconde arrivée garde la première.
- `updateChecklist` : un point inconnu est refusé avec la raison `not_applicable`.
- `reportCustomerAbsent`, `reportSessionMissedAsKsp` : aucune séance n'est manquée avant son heure
  prévue ; un accès impossible n'a pas d'attente réglée.
- `isWithinFreePeriod` : « jusqu'à 24 h avant » borne incluse, comme R-VI-03.
- `cancelSessionAsKsp` : une annulation saisie par le support encore dans le délai reste sans frais ;
  une séance interrompue ou suspendue n'est jamais annulée tardivement au compte du client.
- `customerReschedulesInMonth` : le plafond compte les reports du client sur le programme, dans le
  mois civil de Porto-Novo où il reporte.
