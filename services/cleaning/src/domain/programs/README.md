# Programmes (lot E)

Vie d'un programme de nettoyage (cahier des charges Nettoyage v2, parties 8, 11.3 et 12) :
transitions, progression d'après les séances, suspension et reprise, rattrapage, arrêt. Domaine pur,
sans horloge implicite ; erreurs : `../sessions/errors.ts`.

| Fichier              | Rôle                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `program-status.ts`  | Transitions de 15.2, « en cours » et « terminé » d'après les séances          |
| `suspension.ts`      | Causes cumulables, suspension, reprise, seuil des séances en retard           |
| `catch-up.ts`        | Reprise des séances suspendues, date de rattrapage proposée (R-SU-03)         |
| `program-stop.ts`    | Arrêt par le client (règle des 24 h), arrêt par KSP validé par un autre admin |
| `schedule-change.ts` | Changement du jour ou de l'heure des séances à venir (R-PG-06, R-RP-01)       |
| `amendment.ts`       | Avenant : conditions, séances changées, séances ajoutées (R-PG-06)            |
| `renewal.ts`         | Conditions du renouvellement et de la nouvelle commande (R-PG-07, R-PG-08)    |
| `renewal-plan.ts`    | Plan recalé d'un programme renouvelé, même nombre de séances (R-PG-07)        |

## Matrice règle → test

| Règle                | Code ou issue                            | Cas nominal                                               | Cas limite                                                                  |
| -------------------- | ---------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| 15.2 Programme       | `CLEANING_INVALID_TRANSITION`            | `program-status.spec` « %s → %s est permise »             | « toute autre transition » ; suspendu → terminé refusé                      |
| Partie 8 En cours    | `in_progress`                            | `program-status.spec` « dès une séance démarrée »         | séances seulement planifiées : rien                                         |
| Partie 8, R-PL-10    | `completed`                              | `program-status.spec` « toutes réalisées, manquées… »     | une séance à affecter ou planifiée reste ; confirmé passe par « en cours »  |
| R-PP-04 Seuil        | `add`, `lift`                            | `suspension.spec` « 1 séance en retard, seuil 1 »         | seuil 2 ; repasser sous le seuil ; programme terminé                        |
| R-SU-02 Suspension   | séances gelées, agents libérés           | `suspension.spec` « la séance en cours continue »         | séances closes et en cours non touchées                                     |
| R-SU-01 Décision KSP | `CLEANING_REASON_REQUIRED`, `decidedBy`  | `suspension.spec` « seconde cause… ajoutée »              | motif blanc ; auteur absent                                                 |
| R-SU-01 Cumul        | `cause_added`, `cause_lifted`, `resumed` | `suspension.spec` « le paiement du retard reprend »       | une autre cause reste ; relais sans reprise ; cause absente ; confirmé      |
| R-SU-03 À affecter   | `toAssign`                               | `catch-up.spec` « après maintenant + 48 h »               | 48 h pile : rattrapage                                                      |
| R-SU-03 Rattrapage   | `suggestedStart`                         | `catch-up.spec` « N semaines plus tard »                  | jour exclu ; chevauchement ; fin = début ; séance annulée ignorée ; null    |
| Partie 12 Client     | `maintainedSessionId`                    | `program-stop.spec` « plus de 24 h avant la plus proche » | 24 h − 1 s : maintenue ; séance suspendue jamais maintenue ; terminé refusé |
| Partie 12 KSP        | `CLEANING_SECOND_APPROVER_REQUIRED`      | `program-stop.spec` « validation par un autre admin »     | même personne ; motif vide                                                  |

### Vie du programme (piste P)

| Règle                     | Code ou issue                                            | Cas nominal                                                     | Cas limite                                                                       |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| R-PG-06 Changer le plan   | séances déplacées, `to_assign`                           | `schedule-change.spec` « déplace les séances à venir »          | date d'effet ; durée ; créneau inchangé ; date passée ; chevauchement            |
| R-PG-06 Prix inchangé     | `CLEANING_AMENDMENT_REQUIRED`, `CLEANING_SCHEDULE_EMPTY` | `schedule-change.spec` « un nombre de séances différent »       | plan sans date ; programme suspendu, terminé, annulé                             |
| R-PG-06 Avenant           | `updated`, `added`                                       | `amendment.spec` « nouveau prix sur les séances non démarrées » | séance payée ou démarrée ; équipe ou durée changée ; prix sous les frais déduits |
| R-PG-06 Demande d'avenant | `CLEANING_VALIDATION_FAILED`                             | `amendment.spec` « au moins un type ou une séance »             | type déjà au programme ; date déjà prise ; date d'une séance annulée             |
| R-PG-07 Plan renouvelé    | plan recalé, même nombre de séances                      | `renewal-plan.spec` « hebdomadaire : même jour »                | jour férié ; début en milieu de semaine ; toutes les 12 semaines ; mensuel       |

## Interprétations prudentes (isolées dans une fonction nommée)

- `programProgress` : un programme confirmé dont toutes les séances sont closes passe par « en cours »
  puis « terminé » dans le même geste (15.2 n'a pas confirmed → completed).
- `overdueSuspensionDecision` : reprise de la v1, la cause est levée quand le nombre de séances en
  retard repasse sous le seuil ; une séance encore en retard bloque toujours le démarrage.
- `addSuspensionCause` : un programme terminé ou annulé ne se suspend pas (`CLEANING_INVALID_TRANSITION`).
- `liftSuspensionCause` : à la reprise, « en cours » s'il a une séance démarrée ou réalisée, sinon
  « confirmé ».
- `catchUpStart` : la date de rattrapage respecte aussi le délai minimum ; la recherche s'arrête à
  `maxWeeks`, fixé par l'appelant (le cahier des charges ne donne pas de limite).
- `stopProgramByCustomer` : seule une séance qui aura lieu (à affecter ou planifiée) est maintenue par
  la règle des 24 h, jamais une séance gelée.
- `changeSchedule` : les séances concernées sont « à affecter » ou « planifiées » ; une séance
  suspendue en attente de rattrapage garde son rattrapage. Une séance dont le créneau ne change pas
  n'est pas touchée (ni report, ni retrait d'agents).
- `amendableSessions` : une séance déjà payée d'avance ne prend pas le prix de l'avenant.
- `renewedPlan` : la période du plan renouvelé s'arrête le jour de sa dernière séance ; les jours
  exclus ou ajoutés à la main de l'ancienne période ne sont pas repris.
