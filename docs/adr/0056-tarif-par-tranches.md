# ADR-056 — Catalogue et tarif par tranches du Nettoyage v2

**Statut** : Proposé (2026-11-19)

## Contexte

En v1, une prestation est un formulaire et une grille (ADR-033) : un prix par unité par champ nombre,
des suppléments et des coefficients par valeur, des fréquences propres, un coefficient de commune.
Les types de lieu proposent des prestations (ADR-034). Ce modèle ne sait pas dire « 180 FCFA le m² de
51 à 150 m², 150 FCFA au-delà », ne relie pas un tarif à un couple lieu × type (le sol d'une villa et
celui d'un chantier ont le même prix), et n'a ni pack ni brouillon publié après essai.

Le cahier des charges v2 (parties 4 et 5) définit quatre briques assemblées au back-office : lieu,
type de nettoyage, paramètre, **offre** (lieu × type) portant un **tarif par tranches**.

## Décision

1. **Catalogue** : `PlaceCategory` / `PlaceType` (paramètres du lieu ordonnés, superficie obligatoire
   sauf pour « Autre », R-CA-01), `CleaningType` (compétence requise, liste de contrôle, pack),
   `Parameter` (nature `number`, `choice`, `boolean`, unité, bornes entières, obligatoire, aide),
   `Offer` (lieu × type, paramètres en plus, règle d'équipe, version de tarif en vigueur). Rien n'est
   supprimé : ce qui sert à un dossier se désactive (R-CA-06). Le lieu « Autre » n'a pas de simulateur :
   le prix vient de la visite (R-CA-05).
2. **Paramètre de base** : chaque tarif désigne un paramètre `number` du lieu ou de l'offre (superficie
   par défaut ; surface du jardin, volume de la fosse, nombre de fenêtres…). Ses valeurs sont entières.
3. **Tranches** `{ from, to, mode, amount }` : bornes entières **contiguës** (`from` d'une tranche =
   `to` de la précédente + 1), sans chevauchement ni trou, la première partant de la borne basse du
   paramètre ; `mode` `flat` (forfait) ou `per_unit` (prix par unité × **valeur entière** du paramètre de
   base, R-PX-01). Au-delà de la dernière tranche : « sur devis » pour cette offre, les autres restent
   chiffrées (R-PX-03). Une valeur hors des bornes du paramètre est refusée.
4. **Suppléments** `{ parameter, mode, value }` pour les autres paramètres : `fixed` (montant fixe ; pour
   un oui/non, ajouté sur « oui », jamais sur « non »), `per_unit` (montant × valeur, avec un nombre
   d'unités comprises `includedUnits`, 0 par défaut, pour « chaque chambre au-delà de 3 »), `coefficient`
   (points de base). Un paramètre `choice` porte un supplément par valeur.
5. **Remise de fréquence au niveau de l'offre** (R-PX-06) : coefficients facultatifs par fréquence
   (`frequency_coefficients`), dans les coefficients du prix de l'offre, **avant le minimum**, jamais
   appliqués une seconde fois sur la séance. Fréquence lue dans le plan de séances : `weekly` (chaque
   semaine), `monthly` ; ponctuel et autres rythmes : × 1 (à valider).
6. **Calcul** (partie 5), côté serveur, identique pour le simulateur, la demande, le constat et le
   devis :
   - prix d'une offre = max(minimum, (tarif de la tranche + Σ suppléments) × Π coefficients) ;
   - prix d'une séance = (Σ prix des offres − remise du pack) × coefficient de commune ;
   - prix du programme = Σ prix des séances (= prix d'une séance × nombre de séances, R-PG-05).
   - Francs entiers ; coefficients en points de base (10 000 = × 1, plafond 100 000) ; calcul exact en
     entiers (fractions sur les points de base) et **un seul arrondi au franc, à la fin**, au plus proche
     (R-PX-02). Sans commune connue (visiteur), coefficient neutre (R-PX-05).
   - Le détail ligne par ligne (tranche, suppléments, coefficients, minimum appliqué ou non, version de
     tarif) est rendu et gardé sur la demande, le constat et le devis (R-PX-04).
7. **Packs** (R-CA-04) : un type `is_pack` regroupe des types du même lieu, avec soit un **prix propre**
   (le pack a sa propre offre et son tarif), soit une **remise en pourcentage** sur la somme des offres
   qu'il contient (remise du pack de la décision 6). Choisir le pack masque ses types ; leurs paramètres
   restent demandés.
8. **Fourchette** (R-PX-07) : borne basse = prix × 0,90 arrondi au multiple de 500 inférieur ; borne
   haute = prix × 1,15 arrondi au multiple de 500 supérieur, en entiers. Exemple de la partie 5 :
   32 040 → 28 500 à 37 000 FCFA.
9. **Taille d'équipe et durée** (R-CA-10) : règle de l'offre par tranches du paramètre de base (nombre
   d'agents, durée), modifiable au devis.
10. **Versions et publication** (R-CA-07, R-CA-08) : `TariffVersion` par offre, `draft` → `published` →
    `archived`. Un brouillon se modifie et s'essaie dans le simulateur du back-office
    (`POST /admin/simulations` avec la version brouillon) ; il n'est publié que **complet** (tranches
    contiguës, montants entiers positifs ou nuls, minimum, suppléments sur des paramètres connus du lieu
    ou de l'offre, coefficients dans les bornes) ; publier archive la version précédente. Une version
    publiée ne change plus : toute modification crée un brouillon. Une demande garde la version de
    chaque offre utilisée à sa création ; un devis est figé à son envoi (R-DV-02).

## Alternatives écartées

- **Garder le formulaire par prestation d'ADR-033** : pas de tranches, pas d'offre lieu × type, pas de
  pack.
- **Tranches progressives** (chaque tranche ne facture que sa part, comme un impôt) : non demandé ; la
  partie 5 multiplie la valeur entière par le prix de sa tranche.
- **Remise de fréquence sur la séance ou le programme** : appliquée après le minimum, ou deux fois avec
  celle de l'offre ; R-PX-06 la place dans l'offre.
- **Formule libre saisie au back-office** : dangereuse et difficile à tester (déjà écartée par ADR-033).
- **Arrondi à chaque ligne** : l'écart s'accumule ; un seul arrondi garde le total exact.

## Conséquences

- `cleaning` : domaine pur du catalogue, de la validation d'un tarif et du calcul (couverture d'au moins
  90 %) ; le critère du lot A est l'exemple de la partie 5 au franc près (384 480 FCFA).
- Le prix par unité appliqué à la valeur entière crée un saut à la limite d'une tranche (150 m² × 180 =
  27 000 ; 151 m² × 150 = 22 650) : c'est voulu par la règle, l'admin règle ses tranches en conséquence.
- Le formulaire public ne montre aucun montant : seule la simulation en rend.
- Simulateur public limité à 30 calculs par minute et par adresse ; réponse sous 300 ms.
- ADR-033 est remplacé ; ADR-034 l'est en partie (décisions 1 à 3).

## À valider

- Nombre d'unités comprises (`includedUnits`) d'un supplément par unité, nécessaire à l'exemple
  « chaque chambre au-delà de 3 » mais absent du modèle de la partie 15.1.
- Fréquences qui portent une remise : `weekly` (chaque semaine) et `monthly` ; « toutes les N
  semaines » (N ≥ 2) sans remise.
- Une séance dont une offre est « sur devis » : aucun total ni fourchette, seulement les lignes
  chiffrées et la mention « sur devis ».
- Première tranche obligatoirement alignée sur la borne basse du paramètre de base.
- Montants affichés par ligne arrondis pour l'affichage seulement, le total venant du calcul exact.
