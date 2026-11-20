# Calcul du prix (lot A)

Catalogue et calcul du prix du Nettoyage v2 (cahier des charges, parties 4 et 5). TypeScript pur :
ni horloge, ni aléa, ni dépendance technique. Montants en francs CFA entiers, coefficients en points
de base (10 000 = × 1).

| Fichier                | Rôle                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `types.ts`             | Paramètres, valeurs, tranches, suppléments, tarif, règle d'équipe          |
| `money.ts`             | Calcul exact (BigInt), arrondi au franc moitié vers le haut, fourchette    |
| `tariff-validation.ts` | Cohérence d'un tarif au brouillon et à la publication                      |
| `team.ts`              | Règle d'équipe d'une offre, équipe et durée proposées                      |
| `frequency.ts`         | Clé de fréquence d'un programme, coefficient de remise récurrente          |
| `values.ts`            | Contrôle des types choisis et des valeurs envoyées                         |
| `offer-price.ts`       | Prix d'une offre, détail ligne par ligne, pack à remise                    |
| `pack.ts`              | Composition d'un pack : types simples, jamais un pack dans un pack         |
| `session-price.ts`     | Prix d'une séance et du programme, statut, mentions, équipe                |
| `testing.ts`           | Jeux d'essai : « Maison × Sol », « Maison × Vitres », villa de la partie 5 |

## Matrice règle → tests

| Règle    | Cas nominal                                                                                                         | Cas limite                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-CA-04  | `offer-price` « prix des types, remise à part » ; `session-price` « Σ prix des offres − remise pack »               | pack dans un pack refusé (`pack`), remise 95 % refusée, plafond 90 %, remise réduite au minimum, relevé au minimum, remise nulle, type sur devis (`tariff-validation`, `offer-price`) |
| R-CA-06  | `values` « refuse une valeur inconnue ou désactivée »                                                               | valeur désactivée acceptée au simulateur de test ; `tariff-validation` valeur désactivée connue                                                                                       |
| R-CA-07  | `tariff-validation` « accepte le tarif Maison × Sol »                                                               | tranche réduite à une valeur                                                                                                                                                          |
| R-CA-08  | `tariff-validation` brouillon et publication                                                                        | brouillon sans tranche accepté, publication refusée ; tranches dans le désordre                                                                                                       |
| R-CA-10  | `team` « lit la tranche de la superficie »                                                                          | bornes incluses 100 / 101, 0, 1 000 000                                                                                                                                               |
| R-CA-11  | `tariff-validation` chaque raison : chevauchement, trou, première tranche, base, suppléments, mode                  | trou d'une seule unité, base sans minimum (0), choix sans valeur, bornes 1 et 100 000                                                                                                 |
| R-CA-13  | `team` « maximum des agents, somme des durées » ; `session-price` équipe proposée                                   | sans superficie, règle vide, aucune offre, dernière tranche fermée, trou, chevauchement                                                                                               |
| R-CA-14  | `session-price` équipe lue sur le paramètre superficie du lieu                                                      | superficie à la borne d'une tranche (100)                                                                                                                                             |
| R-PX-01  | `offer-price` forfait, prix par unité                                                                               | 50 au forfait, 51 par unité, 400, valeur 0                                                                                                                                            |
| R-PX-02  | `offer-price` « une ligne par coefficient, somme des lignes = prix » ; `money` calcul exact                         | moitié vers le haut (7,5 → 8), un seul arrondi (6,05 → 6), grands montants, minimum après fréquence et après commune                                                                  |
| R-PX-03  | `values` valeurs justes, bornes incluses                                                                            | 150,5 refusé, hors bornes, 1 000 001, − 1 ; `offer-price` au-delà de la dernière tranche                                                                                              |
| R-PX-04  | `offer-price` détail ligne par ligne de l'exemple                                                                   | ligne « minimum », libellés de repli                                                                                                                                                  |
| R-PX-05  | `session-price` commune desservie appliquée                                                                         | commune inconnue, commune non desservie ; `offer-price` commune neutre sans ligne                                                                                                     |
| R-PX-06  | `frequency` clés ; `offer-price` remise de chaque offre ; `tariff-validation` clés acceptées                        | every_1_weeks, every_13_weeks, clé en double, sans entrée correspondante, ponctuel                                                                                                    |
| R-PX-07  | `money` fourchette 28 500 à 37 000                                                                                  | multiple exact de 500, 0, 1 franc                                                                                                                                                     |
| R-PX-08  | `session-price` prix partiel « à partir de »                                                                        | rien de chiffré, aucune offre, pack chiffré avec une offre sur devis, mentions cumulées                                                                                               |
| R-PX-09  | `values` type en double, pack avec l'un de ses types, paramètre inconnu                                             | ordre indifférent, paramètre désactivé, oui/non facultatif absent = « non »                                                                                                           |
| Partie 5 | `session-price` « exemple de la partie 5 » : 26 640 + 5 400 = 32 040 ; 32 040 × 12 = 384 480 FCFA ; 28 500 à 37 000 | sous-total avant remise 35 600 ; remise de fréquence 3 560                                                                                                                            |

## Interprétations

Chacune est isolée dans une fonction nommée, commentée dans le code :

- `publishWithoutBracket` : un tarif par tranches publié sans tranche est refusé comme un trou au
  rang 0 (`brackets_gap`).
- `packCompositionProblems` : décision du responsable, un pack ne contient jamais un autre pack et
  un type déjà contenu dans un pack ne devient pas un pack (`not_applicable`).
- `packProblems` : un pack à remise ne porte ni base, ni tranches, ni suppléments, ni remise
  récurrente (`not_applicable`) ; la fréquence agit déjà sur chacun de ses types.
- `choiceIsKnown` : un supplément sur un paramètre « choix » exige une valeur connue ; un supplément
  sur un autre paramètre n'en porte pas (`unknown_choice`).
- `supplementQuantity` : un supplément fixe ou un coefficient sur un paramètre nombre s'applique
  pour une valeur strictement positive.
- `communeLineShown` : pas de ligne « commune » quand le coefficient est neutre.
- `frequencyDiscountOf` : la remise de fréquence affichée est la somme des lignes « remise
  récurrente », avant un éventuel minimum.
- `pricedSubtotal` (dans `priceSession`) : la somme « à partir de » déduit la remise des packs
  chiffrés.
