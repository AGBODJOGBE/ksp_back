# ADR-054 — Refonte du Nettoyage (v2) : un dossier = un lieu, la v1 remplacée sur place

**Statut** : Proposé (2026-11-19). Décisions D1 à D9 validées le 19/11/2026.

## Contexte

Le cahier des charges Nettoyage v2 (2026-11-18, points ouverts tranchés le même jour) remplace celui de
la v1. Il change le cœur du module : un dossier porte sur **un lieu** et regroupe tous les types de
nettoyage choisis (un devis, une acceptation, un programme), la visite devient payante, le client voit
l'écart entre ce qu'il a déclaré et ce que l'agent a constaté, chaque séance est une ligne avec ses
agents et son paiement, les agents s'inscrivent et sont planifiés automatiquement, et l'argent ne passe
plus que par le wallet.

La v1 (ADR-033 à 037, 049, 052, 053) a construit ce parcours par ajouts successifs autour d'une
demande par prestation liée par un groupe ; les contrats n'ont changé que par ajout (règle d'or n° 3),
d'où des champs dépréciés, deux formats de simulation et des opérations de groupe partout.

Le projet est en développement : **aucun client réel**, aucune donnée à garder. La partie 17 du cahier
des charges (gel des demandes v1, dossiers v1 menés à leur terme) n'a donc pas d'objet.

La CI refuse toute rupture de contrat (ADR-051) : `buf breaking` (règle `FILE`), `oasdiff breaking
--fail-on ERR` sur `ksp-api.v1.yaml` et `tools/ci/event-schemas-compat.ts` sur `contracts/events`.
Remplacer les routes, les RPC et les événements du Nettoyage fait échouer ces trois contrôles.

## Décision

1. **Un dossier = un lieu.** Le client enregistre ses lieux (« Mes lieux »). Une demande
   (`CleaningRequest`, numéro `DN-000124`) porte sur un lieu et sur un ou plusieurs types de
   nettoyage ; elle donne un devis (`Quote`, versions successives), puis à l'acceptation un programme
   (`Program`, numéro `PN-000057`) dont **toutes les séances** (`Session`) sont créées avec leur date et
   leur prix (R-PG-05). Les groupes de demandes, les opérations de groupe et leurs routes disparaissent.
   Les mots de la v1 « mission » et « passage » deviennent « programme » et « séance ».
2. **Circuit et états** : ceux de la partie 15.2 du cahier des charges (demande, devis, programme,
   séance, paiement de séance, agent) ; toute autre transition répond `CLEANING_INVALID_TRANSITION`.
   Le constat garde trois versions (déclaré, constaté, retenu), chacune avec son auteur, sa date, son
   calcul et sa version de tarif ; l'écart déclaré / retenu est montré au client (R-CS-01, R-CS-02).
   L'agent saisit des valeurs et ne voit jamais de montant (R-EX-04).
3. **La v1 est remplacée sur place, sans reprise de données** (D1, validé le 19/11/2026). Le code v1 du
   module (domaine, cas d'usage, adaptateurs, routes de la gateway, modèles de messages) est remplacé,
   pas conservé à côté. Pour la base `cleaning` :
   - les 15 migrations v1 (`services/cleaning/prisma/migrations/0001_init` à `0017_cleaning_complements`)
     sont remplacées par **une seule migration de départ**, `0001_init_v2` ;
   - toute base `cleaning` de développement est **remise à zéro**, une fois, après la fusion du schéma
     v2 (le fichier `services/cleaning/.env` est copié depuis `.env.example` s'il n'existe pas) :

     ```bash
     pnpm --filter @ksp/cleaning-service exec prisma migrate reset --force
     ```

     La commande supprime les données, applique `0001_init_v2` et régénère le client Prisma. À défaut,
     `docker compose down -v && pnpm infra:up` recrée toutes les bases locales (données des autres
     services comprises) ;

   - les données de démonstration v1 sont remplacées par un jeu v2.

   Dans `billing`, `payment` et `wallet`, dont seule une partie est propre au Nettoyage v1 (contrats de
   facturation, objets payés « mission »), les tables concernées changent par des migrations en avant
   ordinaires dans leur service : ces bases gardent leurs autres données (ADR-055).

4. **Reprises de la v1.** Principe : la v2 ne perd rien de ce que la v1 gère mieux qu'elle. Une
   validation, un cas limite, une protection, un calcul, un message, un délai ou une trace d'audit que
   la v1 tient et que la v2 n'a pas prévu est **repris et amélioré dans la v2**, même quand le concept
   qui le portait disparaît. Les concepts retirés volontairement ne reviennent pas tels quels : groupes
   de demandes (un dossier = un lieu), mission et intervention (remplacées par programme et séance),
   paiement hors wallet.
   - Déjà repris (cahier des charges, partie 17) : moteur du plan de séances (ADR-052, décision 1 ;
     bornes v2 : 24 mois et 400 séances, réglables), zones desservies et coefficient de commune, causes
     de suspension cumulées (ADR-030), confidentialité, masquage et purge des positions (ADR-034
     décision 7, ADR-035 décision 11), photos par `file` (ADR-053 décision 1), tâche des échéances et
     rappel des devis (ADR-053 décision 2), méthodes réservées à la gateway et dossiers d'organisation
     vus dans leur contexte (ADR-049, décisions 1 et 3), devis strictement positif, idempotence
     (`Idempotency-Key`), outbox et inbox.
   - Le reste vient de l'analyse des écarts v1 → v2 (127 écarts vérifiés, décisions du pilote du
     19/11/2026) : **102 reprises**, listées dans l'annexe
     [`docs/adr/annexes/0054-reprises-de-la-v1.md`](annexes/0054-reprises-de-la-v1.md). Chaque
     reprise y est reliée à ce que faisait la v1, à ce que fait la v2 et à sa cible (cahier des
     charges, contrats du Nettoyage, schéma, contrats du socle, code de la vague 2).
5. **Contrats v2 écrits et validés avant le code** (étape « Contrats »), **sur place** (D1) :
   - gRPC : le paquet `ksp.cleaning.v1` (`contracts/proto/ksp/cleaning/v1/cleaning.proto`) est
     **réécrit sur place** ; pas de paquet `ksp.cleaning.v2`. Les services `QuoteService`,
     `MissionService`, `CleaningAdminService` et `MissionPaymentDueService` disparaissent ;
   - REST : les routes `/api/v1/cleaning/*` et `/api/v1/admin/cleaning/*` sont **remplacées sur place**.
     Le préfixe `/api/v1` est gardé pour ce contrat entièrement nouveau (D4) : aucun client réel ni
     ancienne application ne dépend de la v1, la règle « toute rupture passe par `/api/v2` » ne
     s'applique pas à cette refonte. Le back-office suit la convention du dépôt,
     `/api/v1/admin/cleaning/…` (D3) : les rôles et la double authentification s'appliquent à
     `/api/v1/admin/` ; la partie 15.3 du cahier des charges (`/api/v1/cleaning/admin/…`) est corrigée ;
   - événements : noms de la partie 15.5. Les événements `cleaning` v1 sont **supprimés ou réécrits sur
     place**, sans fichier v2 à côté : 16 sont supprimés, 6 sont réécrits (`cleaning.request.cancelled`,
     `cleaning.quote.sent`, `cleaning.quote.expired`, `cleaning.visit.scheduled`, et
     `cleaning.visit.cancelled` et `cleaning.quote.expiry_reminded`, rétablis par les reprises RV-51 et
     RV-53 de l'annexe). Tous leurs
     consommateurs sont dans le dépôt (`notification`, `billing` et `wallet`, plus les types partagés de
     `libs/contracts` et `libs/platform`) et sont mis à jour dans la même branche d'intégration, avant la
     fusion vers `main`.
6. **Branche d'intégration `refonte/nettoyage-v2`**, partie de `main`. Chaque étape est une branche
   courte (`refonte/v2-<sujet>`) fusionnée dans l'intégration par demande de fusion, avec la CI complète
   et une relecture. `main` est fusionnée régulièrement dans l'intégration. Ordre : phase 0 (ADR,
   contrats v2, schéma de la base), puis les **lots A à G** du cahier des charges (partie 18), chacun
   terminé quand son critère d'acceptation passe : A catalogue et simulateur, B comptes, wallet et
   RBAC, C demande, visite et devis, D agents et planification manuelle, E exécution et paiement par
   séance, F entreprise, G planification automatique et finitions. **Une seule fusion vers `main`**,
   une fois les lots validés (à valider).
7. **Ruptures de contrat déclarées, jamais contournées en silence** (D2, validé le 19/11/2026) :
   - **Fichier.** `contracts/accepted-breaks.yaml` liste chaque rupture acceptée. Une entrée nomme son
     outil et la portée la plus étroite possible, sans motif ni joker :
     - `buf` : fichier du module `contracts/proto` et règle buf exacte
       (`ksp/cleaning/v1/cleaning.proto`, `FIELD_NO_DELETE`) ;
     - `oasdiff` : préfixe de chemin REST d'au moins trois segments et identifiant oasdiff exact
       (`/api/v1/cleaning/simulations`, `new-required-request-property`) ;
     - `events` : type d'événement et version publiés sur `main` (`cleaning.quote.sent`, 1).

     Chaque entrée porte aussi son motif (`reason`), l'ADR qui l'autorise (`adr`) et sa date limite
     incluse (`expires`). Une entrée en double, une clé inconnue, un champ manquant ou une portée trop
     large (`*`, `/api/v1`, `cleaning.*`) rendent le fichier invalide.

   - **Contrôle.** `tools/ci/accepted-breaks.ts`, lancé par `pnpm contracts:breaking`, fait tourner les
     trois contrôles **sans changer leurs règles** par rapport à `main` : `buf breaking` (règles de
     `buf.yaml`), `oasdiff breaking` (ruptures de niveau ERR, comme `--fail-on ERR`) et la
     compatibilité des schémas d'événements (`event-schemas-compat.ts`). Il sépare les ruptures
     acceptées des autres et **échoue** sur :
     - toute rupture qu'aucune entrée ne nomme ;
     - un fichier invalide ;
     - une entrée dont la date limite est passée ;
     - toute entrée présente hors de la refonte, c'est-à-dire ailleurs que sur `refonte/nettoyage-v2`,
       une demande de fusion qui la vise, ou sa demande de fusion vers `main`. Une branche d'une copie
       externe du dépôt (fork) ne compte jamais comme la branche d'intégration.

     Une entrée refusée n'accepte aucune rupture. Une entrée qui ne correspond plus à aucune rupture
     est signalée en avertissement, à retirer.

   - **Résumé.** Les ruptures acceptées sont écrites dans le résumé du job (`GITHUB_STEP_SUMMARY`) :
     nombre par outil, « N ruptures acceptées par ADR-054 », tableau des entrées (motif, date limite)
     et détail de chaque rupture ; les ruptures refusées et la cause de l'échec y figurent aussi.
   - **CI.** L'étape « Contrats — aucune rupture non déclarée » remplace les trois étapes séparées. Le
     binaire oasdiff y est toujours téléchargé à une version et une empreinte figées, puis passé au
     script. La CI tourne aussi sur les demandes de fusion vers `refonte/nettoyage-v2`.
   - **Poste de développement.** `pnpm contracts:breaking` marche sous Windows et dans une copie de
     travail git (où `.git` est un fichier) : la référence `main` est extraite par `git show`, sans
     `.git#branch=main`. oasdiff est pris dans le `PATH`, sinon dans l'image Docker officielle
     `tufin/oasdiff` à la même version. Sur une branche courte, la branche visée se donne en option :
     `pnpm contracts:breaking --base refonte/nettoyage-v2`.
   - **Vie du fichier.** Date limite de toutes les entrées : 28/02/2027 ; la repousser est une
     modification du fichier comme une autre. Le fichier est vidé (`breaks: []`) dans la demande de
     fusion qui suit la fusion finale vers `main`. Sa modification exige la relecture du responsable du
     dépôt : le dépôt n'a pas encore de fichier `.github/CODEOWNERS`, à créer par ce responsable avec
     `contracts/accepted-breaks.yaml` et `tools/ci/` à son nom.
   - **Autres services.** Une rupture d'un autre service (par exemple une méthode de `billing`,
     `payment` ou `wallet` propre à la v1 du Nettoyage) se déclare de la même façon, une entrée par
     élément, avec son motif.
   - **Constat du 19/11/2026**, sur les copies de travail des contrats comparées à `main` :
     - Nettoyage : 515 ruptures buf (toutes dans `cleaning.proto`), 169 ruptures oasdiff de niveau ERR
       (routes `/api/v1/cleaning` et `/api/v1/admin/cleaning`) et 43 ruptures d'événements
       (22 événements `cleaning` v1). Elles sont toutes nommées dans le fichier (73 entrées), et le
       contrôle passe ;
     - socle : aucune rupture buf ni d'événement, mais **20 ruptures oasdiff** de niveau ERR, hors du
       Nettoyage : valeurs ajoutées à des listes fermées de réponses (`scopeType` : `zone` sur les
       routes `/api/v1/admin/identity/…` ; `kind` : `cash_top_up` et `bank_transfer_top_up`, `status` :
       `rejected` sur les routes `/api/v1/admin/wallet/…`). Acceptées le 19/11/2026 : valeur ajoutée
       à une énumération de réponse, dont les seuls clients sont les applications KSP en
       développement, mises à jour dans la refonte. Elles sont déclarées dans le fichier, une entrée
       par route (10 entrées), et le contrôle du socle passe.

## Alternatives écartées

- **Paquet `ksp.cleaning.v2` et fichiers v2 d'événements à côté de la v1** : le code v1 continuerait de
  compiler jusqu'à la vague 2, mais il est supprimé dès la première tâche de celle-ci ; les routes REST
  gardent leurs chemins, donc l'OpenAPI est remplacé sur place dans tous les cas ; supprimer plus tard le
  paquet v1 serait une deuxième rupture pour buf. La rupture est acceptée une seule fois, nommée.
- **Migration en avant qui garde l'historique des 15 migrations v1** : elle porterait pour toujours la
  création puis la suppression de tables qui n'ont jamais eu de données réelles ; une seule migration de
  départ donne une base propre, et remettre à zéro une base de développement tient en une commande.
- **Garder la v1 et ajouter la v2 à côté** (routes `/api/v2`, deux modèles en base) : double code et
  double maintenance pour des données qui n'existent pas ; la suppression de la v1 serait de toute
  façon une rupture, seulement repoussée.
- **Migration des dossiers v1** (partie 17 du cahier des charges) : aucun client réel ; du code jetable.
- **Désactiver les contrôles de compatibilité sur la branche**, ou `breaking.ignore` permanent dans
  `buf.yaml` : la règle disparaît en silence et une rupture hors du Nettoyage passerait inaperçue.
- **Contourner les contrôles à la main** (fusion forcée, contrôle marqué non obligatoire) : aucune trace
  de ce qui a été accepté, ni de qui l'a accepté.
- **Corriger la v1 par ajouts** (comme depuis l'ADR-033) : le modèle « une demande par prestation »
  ne porte ni le devis unique, ni le programme de séances, ni le paiement par séance.

## Conséquences

- ADR-033 et 037 sont remplacés ; ADR-030, 034, 035, 049, 052 et 053 le sont en partie (ligne
  « Remplacé » sous leur statut ; ADR-055 à 059 en remplacent d'autres en partie). ADR-051 n'est pas
  modifié : l'exception est bornée, nommée et visible dans chaque exécution de la CI.
- ADR-036 §9 est remplacé pour le Nettoyage : à la suppression d'un compte, l'adresse saisie et
  l'adresse lisible des lieux personnels sont effacées avec la position et le repère (règle R-DP-02 du
  cahier des charges, reprise RV-42 de l'annexe).
- `notification` : modèles et abonnements du Nettoyage réécrits sur les événements v2, dans la même
  branche ; les modèles WhatsApp v2 sont à faire approuver par Meta avant la production.
- Les fronts (portail, back-office, application agent) suivent les nouveaux contrats ; ils ne sont pas
  dans le périmètre de cette refonte back-end.
- Chaque poste de développement remet sa base `cleaning` à zéro une fois (décision 3).
- Le contrôle des ruptures acceptées existe avant la première demande de fusion qui supprime un
  contrat (phase 0).

## Décisions validées

- **D1** — Validé le 19/11/2026 : la v1 est remplacée sur place (proto, routes et événements réécrits,
  une seule migration de départ, bases de développement remises à zéro), et ce que la v1 gère mieux est
  repris dans la v2 (décisions 3 à 5).
- **D2** — Validé le 19/11/2026 : fichier nommé des ruptures acceptées et son contrôle ; aucun contrôle
  de la CI n'est désactivé (décision 7).
- **D3** — Validé le 19/11/2026 : back-office sous `/api/v1/admin/cleaning/…` (convention du dépôt) ;
  la partie 15.3 du cahier des charges est corrigée.
- **D4** — Validé le 19/11/2026 : préfixe `/api/v1` gardé pour le contrat entièrement nouveau.
- **D5** — Validé le 19/11/2026 : identity met toutes les permissions du catalogue dans le jeton de
  `super_admin` (R-RB-04, ADR-057).
- **D23** — Recommandation de la fiche appliquée le 19/11/2026 : la suspension d'une organisation
  (`identity.organization.suspended`, écouté selon la partie 15.5) reste une cause de suspension des
  programmes (ADR-030) et est ajoutée à R-SU-01.
- **Reprises de la v1** — Validé le 19/11/2026 : décisions métier du pilote sur les écarts v1 → v2 et
  recommandations de la fiche (D8 à D36, E2 à E5), listées dans l'annexe (décision 4).
- **Ruptures du socle** — Validé le 19/11/2026 : les 20 ruptures oasdiff du socle (valeurs ajoutées à
  des énumérations de réponse des routes `/api/v1/admin/identity/…` et `/api/v1/admin/wallet/…`) sont
  acceptées et déclarées dans `contracts/accepted-breaks.yaml` (décision 7).

## À valider

- Une seule fusion vers `main` après le lot G, ou une fusion plus tôt (après le lot E par exemple).
- Création de `.github/CODEOWNERS` par le responsable du dépôt.

## Annexe — Reprises de la v1

La liste des reprises est dans un fichier séparé :
[`docs/adr/annexes/0054-reprises-de-la-v1.md`](annexes/0054-reprises-de-la-v1.md) (102 reprises,
RV-01 à RV-102 : ce que faisait la v1, ce que fait la v2, cible).
