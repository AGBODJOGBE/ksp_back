# Catalogue (lot A)

Règles des éléments du catalogue saisis au back-office et de leur visibilité publique (cahier des
charges, partie 4). Le calcul du prix reste dans `../pricing`, le plan de séances dans
`../schedule-plan`.

| Fichier         | Rôle                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| `entries.ts`    | Bornes et cohérence : catégorie, lieu, type, paramètre, offre, zone, jour férié |
| `visibility.ts` | Visibilité en cascade, raisons du masquage, catalogue public trié               |

## Matrice règle → tests

| Règle   | Cas nominal                                 | Cas limite                                                   |
| ------- | ------------------------------------------- | ------------------------------------------------------------ |
| R-CA-01 | `entries` superficie d'un lieu              | lieu « Autre » sans superficie, paramètre en double          |
| R-CA-06 | `entries` paramètre utilisé : désactivation | valeur de choix retirée, bornes resserrées ou élargies       |
| R-CA-09 | `entries` compétence exigée                 | pack sans compétence, compétence donnée à un pack            |
| R-CA-11 | `entries` unité d'un nombre, valeur active  | min > max, 1 000 001, choix sans valeur active               |
| R-CA-12 | `visibility` lieu visible                   | lieu « Autre » sans offre, catégorie masquée, toutes raisons |
| R-CA-13 | `entries` règle d'équipe contiguë           | première tranche au-dessus de 0                              |
| R-CA-14 | `entries` superficie nombre active du lieu  | paramètre oui/non, inactif ou absent du lieu                 |
| RV-27   | `entries` textes, codes, montants bornés    | 101 caractères, code en majuscules, 100 000 001 FCFA         |

## Interprétations

- `offerHiddenReasons` : une offre suit la chaîne de son lieu ; un lieu désactivé masque ses offres
  sous la raison `inactive`, faute de valeur dédiée au contrat.
- `parameterNarrowing` : une borne absente vaut 0 (basse) ou 1 000 000 (haute) ; poser une borne
  là où il n'y en avait pas resserre le paramètre.
