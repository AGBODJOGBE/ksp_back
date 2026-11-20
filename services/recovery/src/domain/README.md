# Domaine

Entités, objets-valeurs, règles et machines à états du service. TypeScript pur : aucune dépendance
à NestJS, Prisma, RabbitMQ ou gRPC (vérifié par ESLint). Réglages et horloge sont toujours passés en
entrée ; une règle refusée rend un `Outcome` avec son code `RECOVERY_*`, traduit par l'application.
Noms, valeurs énumérées et codes d'erreur suivent le contrat `ksp.recovery.v1` (ADR-060 à 062) ; les
deux codes internes sont décrits dans `outcome.ts`.

| Module               | Règles (cahier des charges Recouvrement)                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `case`               | Statuts et étapes du dossier (16.3, partie 5), sauts tracés (R-PR-03), clôtures (R-PR-10)                  |
| `amounts`            | Montant dû (R-SD-08), imputation frais → intérêts → principal (R-EN-03), trop-perçu, accord transactionnel |
| `pricing`            | Règles tarifaires, versions, priorité du tarif négocié, commission à arrondi unique (partie 13, R-CO-01)   |
| `payment-plan`       | Barème, échéances, défaut, renégociation, rappels (6.1, R-EC-01 à 03)                                      |
| `progression`        | Avancement automatique des étapes et séquence de relance amiable (UC-RC-26, étape 3)                       |
| `score`              | Score de recouvrabilité (R-SD-07)                                                                          |
| `deadlines`          | Délais, jours ouvrés, prescription (17.1, partie 2)                                                        |
| `contact-policy`     | Plages et personnes de contact (partie 2, décision 6)                                                      |
| `eligibility`        | Injonction de payer (étape 6)                                                                              |
| `debtor-access`      | Lien et code du débiteur (partie 7, 17.3)                                                                  |
| `import`             | Import par tableur (R-SD-01, R-SD-02)                                                                      |
| `partner`            | Huissiers et avocats (partie 8)                                                                            |
| `decision`           | Décisions du créancier, dont le saut d'étape `stage_skip` (UC-RC-06, 07 ; R-PR-03, R-PR-04)                |
| `promise`, `dispute` | Promesses (R-PR-09), contestations (R-PR-02)                                                               |
| `settings`           | Réglages et bornes (17.1)                                                                                  |
