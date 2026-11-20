# Paiement par séance (lot E)

Paiement d'une séance de particulier (cahier des charges Nettoyage v2, partie 11.1, R-WL-05,
R-WL-06) : montant dû, déduction des frais de visite, débit du wallet, retard, paiement direct,
relance des débits en attente, rappel et alerte de solde. Une entreprise est réglée par la facture
mensuelle (lot F) : ici, seuls son montant dû et sa déduction sont calculés. Domaine pur, sans
horloge implicite ; erreurs : `../sessions/errors.ts`.

| Fichier                  | Rôle                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `payment-status.ts`      | Transitions de 15.2, statut initial, statut lu d'après l'heure            |
| `charge.ts`              | Part du prix due, montant dû, déduction, clé et objet du débit, facture   |
| `debit.ts`               | Débit si le solde couvre, attente sinon, retard, débit réussi, tentatives |
| `start-gate.ts`          | Séance en retard qui bloque la suivante, garantie de solde                |
| `pending-debits.ts`      | Ordre et choix des débits relancés par une recharge (RV-93)               |
| `direct-payment.ts`      | PaySession, page de paiement unique, échéance, montant laissé au wallet   |
| `balance-alerts.ts`      | Rappel la veille, alerte de solde insuffisant, prochaine séance prévue    |
| `lot-e-parcours.spec.ts` | Critère du lot E, de l'arrivée de l'équipe à la facture                   |

## Matrice règle → test

| Règle                     | Code ou issue                                   | Cas nominal                                               | Cas limite                                                              |
| ------------------------- | ----------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 15.2 Paiement             | `CLEANING_INVALID_TRANSITION`                   | `payment-status.spec` « %s → %s est permise »             | rien ne mène à `waived` ; payée ne repasse pas en retard                |
| R-RC-03 Repasse gratuite  | `waived`                                        | `payment-status.spec` « statut initial »                  | `charge.spec` « reste dispensée »                                       |
| R-PP-01 Montant dû        | `due`, `dueBy`                                  | `charge.spec` « son prix est dû, à payer sous 24 h »      | séance déjà à payer : refusée                                           |
| R-EX-02, partie 12 (50 %) | part du prix                                    | `charge.spec` « client absent ou annulation tardive »     | 15 001 → 7 501 ; taux 0 % et 100 % ; accès impossible : 0               |
| Partie 12 Rien à payer    | `not_due`                                       | `charge.spec` « annulation à temps, KSP, faute d'agent… » | frais de visite gardés pour la suite                                    |
| R-FV-05, R-PP-02          | `visitFeeDeduction`                             | `charge.spec` « 5 000 déduits du premier paiement »       | frais > montant dû : reste reporté ; séance couverte : payée sans débit |
| R-WL-03, R-PP-01 Clé      | `cleaning_session:<id>[:<n>]`                   | `charge.spec` « clé tirée de la séance »                  | tentative 2 ; tentative 0 refusée                                       |
| R-PP-06 Facture           | `cleaning_session_invoice:<id>`                 | `charge.spec` « ligne, frais déduits, total »             | lot E : 15 factures                                                     |
| R-PP-03 Solde             | `debit`, `await`                                | `debit.spec` « solde égal au montant »                    | un franc de moins ; payée, dispensée, non due, entreprise : rien        |
| R-PP-04 Retard            | `overdue`                                       | `payment-status.spec`, `debit.spec` « à l'échéance pile » | une seconde avant ; UTC / Porto-Novo ; déjà payée                       |
| R-PP-04 Blocage           | `CLEANING_SESSION_OVERDUE_PAYMENT`              | `start-gate.spec` « séance 3 en retard »                  | échéance pile / + 1 s ; entreprise jamais bloquée                       |
| R-PP-05 Garantie          | `CLEANING_BALANCE_GUARANTEE_NOT_MET`            | `start-gate.spec` « désactivée par défaut », solde égal   | un franc de moins ; le retard passe avant                               |
| RV-93 Recharge            | ordre des débits                                | `pending-debits.spec` « frais, retards, à payer »         | date égale ; solde juste égal / − 1 ; débit trop grand passé            |
| R-WL-05, RV-95 Direct     | `new_page` de ce qui manque                     | `direct-payment.spec` « solde 3 000, dû 10 000 »          | solde suffisant ; wallet insuffisant ; entreprise ; rien à payer        |
| RV-90 Page unique         | `existing_page`, `awaiting_payment`             | `direct-payment.spec` « page en cours renvoyée »          | page expirée à l'instant ; paiement réussi déjà débité                  |
| R-PP-07 Échéance          | `expiresAt`                                     | `direct-payment.spec` « au plus tard l'échéance »         | échéance passée ; sans échéance                                         |
| R-PP-07, RV-89            | `left_in_wallet`                                | `direct-payment.spec` « le débit suit le crédit »         | déjà payée, dispensée, annulée, demande close                           |
| R-PP-05 Rappel            | `cleaning.session.reminder`                     | `balance-alerts.spec` « minuit la veille »                | 23 h 59 min 59 s ; une seule fois ; après le début ; entreprise         |
| R-WL-06 Alerte            | `cleaning.session.balance_insufficient`         | `balance-alerts.spec` « solde qui ne couvre pas »         | solde égal ; une fois par jour de Porto-Novo                            |
| Lot E (partie 18)         | 15 débits, 15 factures ; blocage puis déblocage | `lot-e-parcours.spec` « 15 séances… »                     | « une séance en retard bloque la suivante et le paiement la débloque »  |

## Interprétations prudentes (isolées dans une fonction nommée)

- `initialPaymentStatus` : `waived` est le statut de création d'une repasse gratuite, jamais l'issue
  d'une transition.
- `missedChargeApplies` : un accès impossible n'est pas facturé (« à valider » dans le contrat).
- `chargeSession` : une séance entièrement couverte par les frais de visite est payée sans débit, et
  sa facture est émise ; un montant dû nul laisse le paiement « non dû ».
- `expectedSessionAmount` : la garantie, le rappel et l'alerte portent sur le prix moins les frais
  qui restent à déduire.
- `overdueSessionsBlockingStart` : toute autre séance du programme en retard bloque le démarrage,
  quel que soit le seuil de suspension.
- `debitsToRelaunch` : un débit plus grand que le solde restant est passé sans bloquer les suivants.
- `paySession` : si le solde couvre déjà le montant, le wallet est débité même si le client a choisi
  Mobile Money.
- `directPaymentExpiry` : une séance déjà en retard n'a plus d'échéance ; la page garde celle du
  prestataire.
- `sessionPayability` : une séance « non due » est comptée « annulée ».
- `isReminderDue` : le rappel part dès minuit la veille, ou encore le jour même avant le début si la
  tâche n'est pas passée.
