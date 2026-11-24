# Organisations : situation d'impayés (lot F)

Situation d'une organisation cliente vis-à-vis de ses factures mensuelles (cahier des charges
Nettoyage v2, partie 11.2, R-PE-06, partie 11.3 ; reprises RV-83 à RV-87). Domaine pur, sans horloge
implicite ; erreurs : `../requests/errors.ts`. Réutilise sans les modifier les causes cumulables de
`../programs/suspension.ts` et la reprise des séances de `../programs/catch-up.ts`.

**Branchement** : `application/organizations` (cas d'usage `OrganizationStandingUseCases`, réglages
`StandingSettings`, écritures des programmes par la suspension et la reprise du lot E),
`infrastructure/persistence/organizations` (unité de travail et verrou de l'organisation) et
`infrastructure/messaging/organization-events.consumer.ts` (les quatre événements écoutés). La
décision de KSP sur l'organisation (`identity.organization.suspended` / `.reactivated`) suit
`ksp-standing.ts` : un événement plus ancien que la dernière décision est ignoré, à date égale la
suspension l'emporte ; elle pose ou lève la cause `organization_suspended` sous le même verrou.

| Fichier           | Rôle                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `standing.ts`     | Seuils, factures suivies, compte d'impayés, décision (avertir, suspendre, lever), événement |
| `alignment.ts`    | Changements des programmes : suspension, cause ajoutée ou levée, reprise et réaffectation   |
| `react.ts`        | Enchaînement décision → programmes → avertissement, à écrire dans une seule transaction     |
| `acceptance.ts`   | Acceptation de devis refusée au seuil, avertissement non bloquant d'une demande             |
| `ksp-standing.ts` | Décision de KSP sur l'organisation : départage par date (RV-85)                             |
| `ports.ts`        | Ports du branchement (interfaces seules)                                                    |

## Ports du branchement

Toutes les méthodes s'exécutent dans la transaction de `OrganizationStandingUnitOfWork.run`, sous le
verrou de l'organisation (RV-85 : `SELECT … FOR UPDATE` sur `organization_billing_standings`, verrou
consultatif si la ligne n'existe pas ; même verrou que `SubmitRequest`, `PayVisitFee`, `AcceptQuote`
et les écouteurs `identity.organization.*`).

| Port                              | Méthodes                                                                                                                                                                  | Tables et contrats                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OrganizationStandingUnitOfWork`  | `run(organizationId, work)`                                                                                                                                               | transaction et verrou                                                                                                          |
| `OrganizationStandingTransaction` | `markProcessed`, `standing`, `saveStanding`, `invoiceStanding`, `saveInvoiceStanding`, `overdueInvoiceIds`, `openPrograms`, `applyProgramChanges`, `publishUnpaidWarning` | `processed_events`, `organization_billing_standings`, `organization_invoices`, `programs`, `sessions`, outbox, journal d'audit |
| `OrganizationStandingSettings`    | `thresholds`, `firstSessionLeadHours`, `excludedDays(programId)`                                                                                                          | `cleaning_settings` (`unpaidInvoicesWarning`, `unpaidInvoicesSuspension`), jours exclus et fériés                              |

Déroulé attendu à la réception de `billing.invoice.overdue` ou `billing.invoice.paid` (versions 1 et
2, `versions: [1, 2]` ; billing publie la v2 pour une facture mensuelle) :

1. `isTrackedInvoice` : seules les factures `source = cleaning`, `kind = monthly`, avec organisation.
2. `run(organizationId)` : `markProcessed` (doublon : fin) ; `nextInvoiceStanding` puis
   `saveInvoiceStanding` (une facture soldée ne redevient jamais impayée) ; `overdueInvoiceIds`.
3. `reactToUnpaidCount` avec `standing`, `openPrograms`, les seuils et les règles de reprise.
4. `applyProgramChanges` (événements `cleaning.program.suspended`, `.suspension_updated`,
   `.resumed`, avec `unpaidCount`), `saveStanding`, et `publishUnpaidWarning` si un avertissement est
   rendu.

Même appel à `reactToUnpaidCount` après un changement des seuils et à la reprise d'un programme de
l'organisation pour une autre cause (réévaluation). `AcceptQuote` passe `acceptanceStanding(...)` à
`acceptQuote` (quotes) ; la lecture d'une demande ajoute `requestWarnings(...)`.

## Matrice règle → test

| Règle                          | Code ou issue                             | Cas nominal                                            | Cas limite                                                            |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 16.1 Seuils                    | `unpaidInvoicesWarning`, `...Suspension`  | `standing.spec` « valeurs par défaut valides »         | 0, 13, avertissement = suspension, non entier                         |
| RV-87 Factures suivies         | `isTrackedInvoice`, `nextInvoiceStanding` | `standing.spec` « seules les factures mensuelles »     | soldée puis impayée : reste soldée ; facture de séance ignorée        |
| R-PE-06 Avertissement          | `cleaning.organization.unpaid_warning`    | `lot-f-parcours.spec` « mois 2 … avertissement »       | même niveau rejoué ; niveau redescendu ; organisation sans programme  |
| R-PE-06 Suspension             | cause `unpaid_invoices`                   | `lot-f-parcours.spec` « mois 3 … tous les programmes » | séance en cours non interrompue ; programme terminé ignoré            |
| R-SU-01 Cumul (RV-84)          | `cause_added`, `cause_lifted`             | `lot-f-parcours.spec` « p3 reste suspendu par KSP »    | cause déjà posée ou absente : rien (`alignment.spec`)                 |
| R-SU-01 Pas d'avertissement    | `warn: false`                             | `standing.spec` « pendant une suspension ; réévalué »  | un programme suspendu sur deux : avertissement                        |
| R-SU-03 Reprise, réaffectation | `toAssign`, `catchUp`                     | `lot-f-parcours.spec` « paiement de décembre »         | jours exclus propres au programme (`alignment.spec`)                  |
| RV-86 Acceptation au seuil     | `CLEANING_ORGANIZATION_UNPAID_INVOICES`   | `acceptance.spec` « acceptation refusée »              | 1 impayée : acceptée ; avertissement de la demande au seuil seulement |

Critère du lot F (domaine) : `lot-f-parcours.spec.ts` — mois 1 payé, mois 2 et 3 impayés →
suspension ; paiement → reprise et réaffectation.

## Interprétations prudentes (isolées dans une fonction nommée)

- `decideOrganizationStanding` : une organisation sans programme en cours est avertie (elle doit de
  l'argent et ne peut plus accepter de devis au seuil) ; au seuil de suspension, aucun avertissement
  si tous ses programmes sont suspendus après la décision.
- `decideOrganizationStanding` : à la reprise après paiement, le nombre restant n'avertit que s'il
  dépasse le niveau déjà averti (le niveau ne redescend qu'avec le nombre).
- `alignPrograms` : la cause `unpaid_invoices` ne touche que les programmes non terminés ; la reprise
  suit `liftSuspensionCause` (« en cours » si une séance a démarré, sinon « confirmé »).
