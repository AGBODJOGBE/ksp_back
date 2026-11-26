# ADR-061 — Accès du débiteur sans compte, porté par `recovery`

**Statut** : Accepté (2026-11-20). Décision validée par le responsable le 20/11/2026.

## Contexte

Le débiteur n'a pas de compte KSP. La partie 7 du cahier des charges lui donne un lien personnel,
envoyé par SMS, WhatsApp ou e-mail, qui s'ouvre après un code reçu au téléphone, valable 30 jours et
renouvelé à chaque relance ; il y consulte sa dette, paie, propose un échéancier, conteste ou demande
un rappel, sans jamais voir d'autre dossier (R-DB-01). La partie 17.3 fixe : jeton aléatoire stocké
haché, code à chaque ouverture, 5 essais puis blocage d'une heure.

La partie 16.1 confie cet accès à `identity`. Or `identity` ne gère que des comptes, et deux accès
sans compte existent déjà dans le service qui possède l'objet : le lien de paiement de `payment`
(ADR-040) et le lien de signature de `document` (ADR-044).

## Décision

1. **Porté par `recovery`**, comme les liens de paiement et de signature : `identity` ne connaît
   aucune personne sans compte. Corrige la partie 16.1 du cahier des charges.
2. **Lien** : jeton de 32 octets aléatoires (43 caractères en base64url), dont seule l'**empreinte
   SHA-256** est gardée ; un lien par débiteur et par dossier ; valable 30 jours (réglable, 7 à 90),
   **renouvelé à chaque relance** (nouveau jeton, l'ancien est révoqué). Adresse :
   `<RECOVERY_DEBTOR_BASE_URL>/<jeton>` (page du portail, chemin à fixer avec le front). Un jeton mal
   formé, inconnu, révoqué ou expiré répond **404 `RECOVERY_DEBTOR_LINK_INVALID`**, sans distinction.
3. **Code à chaque ouverture** : 6 chiffres tirés par un générateur cryptographique, valable 10
   minutes, envoyé par `notification.SendNotification` directement au téléphone du débiteur (WhatsApp,
   SMS en repli ; modèle d'authentification **secret**, sur le modèle `ksp_otp`). Un débiteur **sans
   téléphone** reçoit le code **par e-mail**, à l'adresse du dossier ; seule l'empreinte
   HMAC-SHA256 du code est gardée (clé hors de la base). Un code par minute ; **5 codes faux : accès
   bloqué une heure** (`RECOVERY_DEBTOR_LOCKED`, `retryAfterSeconds`). Les essais sont décomptés de
   façon atomique (ADR-050).
4. **Session débiteur** : à la validation du code, un jeton de session opaque de 43 caractères, rendu
   une seule fois, dont seule l'empreinte est gardée ; **30 minutes** (réglable, 5 à 120), révocable
   (`POST /api/v1/recovery/debtor/session/end`), révoquée aussi au renouvellement du lien et à la
   clôture du dossier. La session ne donne accès qu'à **un dossier** et à **un débiteur**.
5. **Transmission par la gateway** : routes publiques `/api/v1/recovery/debtor/…`
   (`x-ksp-access: public`). Le jeton du lien est dans le chemin (`/access/{token}`), la session dans
   l'en-tête **`X-Debtor-Session`** (schéma de sécurité `debtorSession`), transmis à `recovery` dans la
   métadonnée gRPC `x-debtor-session`. Aucun des deux n'est journalisé (gateway, recovery, traces).
   Session absente, expirée ou révoquée : 401 `RECOVERY_DEBTOR_SESSION_INVALID`. La gateway ne vérifie
   pas la session : `recovery` le fait à chaque appel.
6. **Limites par adresse IP** à la gateway : ouverture du lien 30 par minute, demande de code 3,
   validation 10, routes de session 60, création d'un paiement 5, envoi de pièces 10 ; `recovery`
   ajoute ses limites par lien et par session.
7. **Ce que voit le débiteur** (R-DB-01) : nom du créancier seulement (jamais ses coordonnées), nature
   et références de la dette, montant dû détaillé, paiements et reçus, pièces choisies par KSP
   (`visibleToDebtor`), échéancier, remise autorisée par le créancier, barème du simulateur. Jamais
   un autre dossier, jamais les notes internes, jamais les autres débiteurs du dossier.
8. **Actions** : paiement par lien (ADR-060, décision 7), simulation et proposition d'échéancier
   (signature par le lien de `document` envoyé à son téléphone : la signature vaut reconnaissance de
   dette), contestation avec pièces (envoi par adresse présignée de `file`, finalité
   `recovery_evidence`, déclarée par `recovery` pour le compte du débiteur, 10 pièces au plus par
   session), demande de rappel dans les plages de contact, lecture de ses documents par une adresse
   de courte durée.
9. **Premier message** (R-DB-02) : qui contacte, pour le compte de qui, pourquoi, comment contester,
   et l'information sur le traitement de ses données ; envoyé par `notification` avec le téléphone ou
   l'e-mail du débiteur, jamais par un événement.
10. **Compte facultatif** (R-DB-04) : un débiteur peut créer un compte KSP pour retrouver ses
    dossiers ; le rattachement (téléphone vérifié égal à celui du dossier) est traité plus tard, il
    n'est jamais obligatoire.

## Alternatives écartées

- **Débiteur dans `identity`** (jeton d'accès restreint d'un « invité ») : `identity` stockerait des
  personnes sans compte et leurs dossiers ; chaque service devrait comprendre ce rôle.
- **Jeton du lien à chaque appel, sans session** : le code serait redemandé à chaque écran, ou le jeton
  de 30 jours deviendrait un secret suffisant à lui seul.
- **Session dans un cookie** : le portail et l'API n'ont pas la même origine ; l'en-tête suit le
  modèle du jeton d'accès.

## Conséquences

- Variables de `recovery` : `RECOVERY_DEBTOR_BASE_URL`, `RECOVERY_DEBTOR_CODE_HMAC_SECRET` (coffre,
  refusée en production si elle vaut celle du développement).
- `gateway` : transmission de l'en-tête `X-Debtor-Session` en métadonnée, masqué dans les journaux,
  autorisé par le CORS des origines du portail.
- `notification` : modèle secret `recovery.debtor_access_code` et modèles de messages au débiteur.
- Portail : pages du lien du débiteur (code, situation, paiement, échéancier, contestation).

## À valider

- Chemin de la page du portail (`/recouvrement/<jeton>` proposé).
- Durée de la session (30 minutes) et nombre de pièces par contestation.

## Complément (25/11/2026) : espace du débiteur après la clôture

La clôture révoquait les liens du débiteur : il ne pouvait plus télécharger son attestation de solde.
Désormais, ses liens encore valables le restent, **en lecture seule**, jusqu'à la clôture + 30 jours
(`RECOVERY_DEBTOR_CLOSED_ACCESS_DAYS`, 0 : révoqués comme avant), et l'attestation de solde lui est
envoyée avec un lien neuf de la même durée. La session y lit sa situation et ses documents
(attestation de solde et reçus seulement) ; paiement, échéancier, contestation, pièce et rappel
répondent `RECOVERY_INVALID_TRANSITION` (statut `closed`). Au-delà, lien et session répondent comme
un jeton inconnu. Un dossier refusé ne garde aucun accès.
