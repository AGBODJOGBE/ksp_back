# ADR-040 — Lien de paiement pour un payeur sans compte

**Statut** : Proposé (préalable au Recouvrement, 2026-11-07)

## Contexte

Le Recouvrement (lot 3) fait payer des débiteurs qui **n'ont pas de compte KSP** : ils reçoivent un lien
par SMS ou WhatsApp et règlent chaque échéance par Mobile Money. Le paiement en ligne existant (ADR-031)
suppose un payeur connecté et un montant lu dans cleaning ou billing. Les protections décidées depuis
(pas de second paiement d'un objet réglé, écart de montant bloquant : ADR-032) doivent rester vraies.

## Décision

1. **Lien de paiement dans `payment`** : un service émetteur autorisé (`PAYMENT_LINK_ISSUERS`, `recovery`
   au lancement, jeton de service ADR-022) crée un lien par `PaymentLinkService.CreatePaymentLink` : objet
   de l'émetteur (`subjectType` libre — minuscules, chiffres, « _ », 3 à 50 caractères, par exemple
   `recovery_installment` ; `cleaning_mission` et `billing_invoice` réservés —, `subjectId`), référence
   lisible, bénéficiaire affiché (créancier), libellé, **montant fixe** en XOF (1 à 1 000 000 000),
   échéance facultative, expiration obligatoire (1 heure à 180 jours), nom et téléphone du payeur
   facultatifs. Idempotent par (émetteur, clé). L'émetteur ne voit et ne révoque que ses liens
   (`GetPaymentLink`, `RevokePaymentLink`).
2. **Jeton** : HMAC-SHA256 de l'identifiant du lien avec un secret du service
   (`PAYMENT_LINK_TOKEN_SECRET`, coffre, 32 caractères au moins, refusé en production s'il vaut celui du
   développement), en base64url : **43 caractères, 256 bits**, imprévisible. La base ne garde que son
   **empreinte SHA-256**, qui sert à retrouver le lien. Dérivé plutôt que tiré au hasard : l'émetteur peut
   relire l'adresse (rejeu d'une création après une panne, renvoi du message) sans que le jeton soit
   jamais stocké. Adresse envoyée au payeur : `<PAYMENT_LINK_BASE_URL>/<jeton>` (page du portail).
3. **Un seul lien payable par objet** : la création est refusée si l'objet est déjà payé
   (`PAYMENT_LINK_ALREADY_PAID`) ou si un lien actif ou en vérification existe
   (`PAYMENT_LINK_ALREADY_ACTIVE`) ; l'émetteur révoque l'ancien d'abord.
4. **Chaque essai est une intention de paiement ordinaire**, sans payeur connecté (`customer_id` nul,
   `payment_link_id` renseigné ; contrainte en base : exactement l'un des deux). Même prestataire, même
   confirmation par notification signée puis relecture, même rapprochement, même réussite tardive, même
   `amount_mismatch` et même traitement par la finance (ADR-031, ADR-032). Idempotent par (lien, clé) ;
   un essai en attente est réutilisé (une seule page payable par lien) ; retour du payeur sur la page du
   lien.
5. **Statut du lien**, déduit de ses essais et de son état : `paid` > `under_review` > `revoked` >
   `expired` > `active`. Un paiement réussi l'emporte sur tout : une réussite tardive sur un lien révoqué
   ou expiré est de l'argent reçu, elle est enregistrée.
6. **Refus d'un essai** : objet déjà payé, par ce lien ou un autre (409 `PAYMENT_LINK_ALREADY_PAID`) ;
   écart de montant non traité (409 `PAYMENT_UNDER_REVIEW`, alerte) ; lien révoqué (422
   `PAYMENT_LINK_REVOKED`) ou expiré (422 `PAYMENT_LINK_EXPIRED`) ; plus de
   `PAYMENT_LINK_ATTEMPTS_PER_HOUR` essais (10) par heure sur le lien (429
   `PAYMENT_LINK_TOO_MANY_ATTEMPTS`). Le rejeu d'une même clé passe avant.
7. **Événement** : la réussite publie **`payment.link.paid`** (identifiants, référence, montant,
   prestataire ; ni nom ni téléphone), jamais `payment.intent.succeeded` : celui-ci est écouté par
   cleaning, billing et notification, qui supposent un payeur connecté (reçu au compte). Aucun
   consommateur existant n'est touché ; le service émetteur (recovery) écoutera `payment.link.paid`
   selon `subjectType`. Un échec ne publie rien (le payeur réessaie depuis la page).
8. **Routes publiques** (gateway, sans compte) : `GET /api/v1/payment/links/{token}` (résumé sans donnée
   personnelle : bénéficiaire, libellé, référence, montant, échéance, expiration, statut, dernière
   tentative ; une tentative en attente est relue chez le prestataire au passage) et
   `POST /api/v1/payment/links/{token}/pay` (`Idempotency-Key`). Limites par IP : 30 et 5 par minute.
   Jeton mal formé : 404, comme un jeton inconnu, sans appel de payment. Simulation en développement :
   `POST /api/v1/payment/links/{token}/simulate`.

## Page publique du portail (à faire avec le Recouvrement)

Route proposée : `/payer/[token]` (valeur de `PAYMENT_LINK_BASE_URL`). Elle appelle :

1. `GET /api/v1/payment/links/{token}` à l'ouverture : afficher bénéficiaire, libellé, référence, montant,
   échéance ; selon `status` : `active` → bouton « Payer par Mobile Money » ; `paid` → « Paiement reçu,
   merci » (date `paidAt`) ; `under_review` → « Paiement en cours de vérification, contactez le support » ;
   `revoked` / `expired` → « Lien plus valable, contactez l'expéditeur ». Si `payment.status` vaut
   `pending` avec un `checkoutUrl`, proposer de reprendre la page de paiement.
2. `POST /api/v1/payment/links/{token}/pay` avec une clé `Idempotency-Key` générée une fois par clic
   (gardée en `sessionStorage` pour les nouveaux essais), puis redirection vers `checkoutUrl`.
3. Au retour du prestataire (même adresse), interroger `GET …/links/{token}` toutes les 3 secondes (une
   minute au plus) jusqu'à `payment.status` final : `succeeded` → reçu ; `failed`/`cancelled`/`expired`
   → proposer un nouvel essai ; `amount_mismatch` → message de vérification.
4. Erreurs : 404 `PAYMENT_LINK_NOT_FOUND`, 409/422/429 ci-dessus (messages en français du contrat),
   503 `PAYMENT_PROVIDER_UNAVAILABLE` (réessayer avec la même clé). Développement : la page simulée
   reçoit `?paymentId=` et appelle `POST …/links/{token}/simulate`.

## Alternatives écartées

- **Jeton aléatoire stocké en clair** : une fuite de la base donnerait tous les liens payables.
- **Jeton aléatoire, seule l'empreinte gardée** : l'adresse ne pourrait plus être relue (rejeu d'une
  création interrompue, renvoi du message) ; il faudrait un second lien.
- **Étendre `payment.intent.succeeded`** (payeur nul, nouveaux types d'objet) : rupture pour trois
  consommateurs (reçu envoyé à un compte inexistant, filtres par type) ; un événement dédié est un ajout.
- **Montant envoyé par la page** : falsifiable ; le montant est celui du lien, fixé par l'émetteur.
- **Remplacer automatiquement l'ancien lien** à la création : un paiement en cours sur l'ancien serait
  annulé sans que l'émetteur le sache ; la révocation explicite garde la décision chez lui.

## Conséquences

- Migration `0005_payment_links_payouts` de payment : table `payment_links`, `customer_id` devient
  facultatif, `payment_link_id` et contrainte « payeur ou lien ». Le contrat REST `Payment` porte
  `paymentLinkId`, `customerId` peut être nul et `subject.type` accepte les types des émetteurs : le
  back-office doit les afficher (liste des paiements).
- Configuration : `PAYMENT_LINK_BASE_URL` (HTTPS en production), `PAYMENT_LINK_TOKEN_SECRET`,
  `PAYMENT_LINK_ISSUERS`, `PAYMENT_LINK_ATTEMPTS_PER_HOUR`. Jetons de service : `recovery` → `payment`.
- Le jeton figure dans l'adresse de retour transmise au prestataire : acceptable (il ne permet que de
  voir le résumé et de payer).
- Deux créations simultanées pour un même objet avec des clés différentes peuvent produire deux liens
  actifs (contrôle applicatif, pas de contrainte en base) ; l'émetteur sérialise ses créations.
- **À valider** : conservation du nom et du téléphone du payeur (aujourd'hui gardés avec le lien, jamais
  montrés publiquement ni journalisés) — durée et purge ; texte légal de la page publique ; plafond de
  montant par lien (aujourd'hui 1 000 000 000 XOF, les plafonds des opérateurs s'appliquent en plus).
