# ADR-041 — Reversements par Mobile Money

**Statut** : Proposé (préalable au Recouvrement, 2026-11-07)

## Contexte

Chaque somme encaissée pour un créancier lui est reversée, moins la commission de KSP (ADR-042). Il faut
envoyer de l'argent vers un compte Mobile Money (MTN, Moov, Celtiis au Bénin), suivre l'issue et la
rendre au service qui l'a demandée. FedaPay documente publiquement une API de reversement
(« payouts ») : création, lancement, relecture, notifications. Elle n'est pas encore activée ni essayée
sur le compte KSP.

## Décision

1. **Reversement dans `payment`** : un service autorisé (`PAYMENT_PAYOUT_ISSUERS`, `wallet` au lancement,
   jeton de service) le demande par `PayoutService.RequestPayout` : montant XOF, bénéficiaire (numéro
   +229 de 8 ou 10 chiffres, opérateur `mtn`/`moov`/`celtiis`, nom), référence de l'émetteur, clé
   d'idempotence (par émetteur). `GetPayout` : l'émetteur ne voit que les siens.
2. **Deux exécutions**, choisies par `PAYOUT_PROVIDER` :
   - **`manual` (défaut)** : aucun appel ; le reversement reste `requested` et la finance fait le
     virement elle-même, puis le **confirme** (`POST /api/v1/admin/payment/payouts/{id}/confirm`,
     référence du virement) ou le **déclare en échec** (`…/fail`, raison) au back-office ;
   - **`fedapay`** : le reversement est **créé** chez FedaPay (aucun argent ne part), son identifiant
     enregistré, puis **lancé**. Une réponse perdue au lancement est rattrapée en **relisant** le
     reversement avant tout nouveau lancement : jamais deux envois. Une création perdue laisse au pire un
     reversement jamais lancé chez FedaPay. Relecture par le rapprochement planifié (`processing`) et par
     les notifications `payout.*` reçues sur le webhook existant (signature vérifiée, statut relu, comme
     pour les transactions). Un montant ou une devise relus différents ne sont pas appliqués (alerte).
3. **Statuts** : `requested` → `processing` (lancé chez le prestataire) → `completed` | `failed` ; en
   manuel, `requested` → `completed` | `failed`. Une issue est définitive.
4. **Événements** (outbox, une seule fois par reversement) : `payment.payout.completed` (référence du
   virement) et `payment.payout.failed` (code `provider_failed` ou `rejected_by_finance`). Ni numéro, ni
   nom, ni raison détaillée : la raison reste dans payment.
5. **Back-office** : `GET /api/v1/admin/payment/payouts` (filtres statut, émetteur ; numéro complet
   affiché, nécessaire au virement manuel), confirmation et échec rejouables (clé facultative, ou même
   compte, même issue, même texte). Rôles **`finance_officer`, `super_admin`** (pas `cleaning_admin` :
   c'est de l'argent sortant), double authentification de moins de 12 heures. Confirmer à la main un
   reversement exécuté par le prestataire est refusé (`PAYMENT_PAYOUT_NOT_MANUAL`).

## Alternatives écartées

- **Activer FedaPay d'emblée** : l'API n'a pas été essayée avec le compte KSP (modes par opérateur,
  format du numéro, statuts, notifications) ; une erreur enverrait de l'argent au mauvais endroit.
- **Créer et lancer en un appel** : une réponse perdue obligerait à choisir entre ne rien faire
  (reversement bloqué) et relancer (risque de double envoi).
- **Le numéro dans les événements** : donnée personnelle ; les consommateurs n'en ont pas besoin.

## Conséquences

- Migration `0005_payment_links_payouts` : table `payouts` (contraintes : montant positif, statuts,
  issue datée). Configuration : `PAYOUT_PROVIDER`, `PAYMENT_PAYOUT_ISSUERS` ; FedaPay réutilise
  `FEDAPAY_SECRET_KEY`. Jetons de service : `wallet` → `payment`.
- Le numéro et le nom du bénéficiaire sont conservés dans payment (exécution, contrôle de la finance),
  jamais journalisés.
- **À valider avec le compte FedaPay** avant `PAYOUT_PROVIDER=fedapay` : activation des reversements,
  noms des modes par opérateur (supposés `mtn_open`, `moov`, `sbin` pour Celtiis), format du client
  (`lastname`, `phone_number` `{ number, country: 'bj' }`), route de lancement (`PUT /payouts/start`),
  statuts (`pending`, `started`, `processing`, `sent`, `failed`), noms des notifications (`payout.*`),
  frais et délais.
- **À valider (finance)** : qui confirme les virements manuels, avec quelle pièce ; seuil au-delà duquel
  une double validation serait exigée (non prévue aujourd'hui).
