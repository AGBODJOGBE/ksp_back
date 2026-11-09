# ADR-046 — Portefeuille prépayé de chaque client

**Statut** : Proposé (décision du responsable, 2026-11-09)

## Contexte

Le responsable a décidé : « Chaque client a son wallet pour faire ses opérations sur la plateforme selon
le service choisi. Le service débite directement le wallet du client ; le client (ou l'utilisateur)
recharge juste son wallet. » Jusqu'ici, chaque mission ou facture se payait par sa propre page Mobile
Money (ADR-031), avec les protections d'ADR-032. Le service `wallet` existe (ADR-042) : grand livre en
double entrée, écritures immuables, soldes tenus par PostgreSQL, mais il ne porte que les fonds dus aux
créanciers du Recouvrement, reversables.

## Décision

1. **Dans le service `wallet` existant, même grand livre** (pas de nouveau service) : un second compte
   par titulaire, `prepaid:<user|organization>:<id>`, ouvert à la première écriture, distinct du compte
   `holder:` d'ADR-042. Il est **dépensable et jamais reversé** ; les fonds de créancier restent
   reversables et ne paient aucun service. Mélanger les deux permettrait de retirer en Mobile Money une
   recharge (frais, blanchiment) ou de dépenser des fonds dus à un créancier. Comptes internes
   `ksp:prepaid_funds` (recharges reçues, sens débit) et `ksp:service_revenue` (services payés, sens
   crédit). Invariant : recharges reçues = Σ portefeuilles + services payés.
2. **Jamais négatif** : contrôle sous le verrou du compte (comme un reversement), puis contrainte de la
   base (`kind <> 'prepaid' OR balance >= 0`) que le déclencheur du solde ne peut pas franchir.
3. **Écritures** (migration `0004_prepaid_wallet`, ajouts seulement) : `top_up` (D recharges / C
   portefeuille), `service_payment` (D portefeuille / C services), `refund` (écriture inverse d'un
   débit, ou crédit de la finance). Colonnes `actor_id` (client qui paie ou recharge, membre de la
   finance) et `object_type`/`object_id`/`object_part` (objet payé chez le service).
4. **Recharge** : `POST /api/v1/wallet/me/top-ups` (montant, `Idempotency-Key`) → wallet contrôle les
   limites (`WALLET_TOP_UP_MIN` 500, `WALLET_TOP_UP_MAX` 1 000 000 XOF, **à valider**) et le rôle
   (organisation : `org_admin` ou `org_member` ; `org_viewer` en lecture seule) → payment
   (`TopUpPaymentService.CreateTopUpPayment`, réservé à wallet) crée une intention d'objet
   `wallet_top_up`, identifiant = titulaire (organisation active, sinon le payeur), payeur = l'utilisateur
   transmis dans les métadonnées, et renvoie la page du prestataire. Une page ouverte du même payeur est
   réutilisée pour le même montant, remplacée sinon. À `payment.intent.succeeded` de ce type, wallet
   crédite le portefeuille (inbox dans la même transaction, référence `payment:<id>` unique).
5. **Écart de montant d'une recharge : blocage, puis crédit par la finance**. Le prestataire qui
   approuve un autre montant (ou une devise non établie comme XOF) laisse le paiement `amount_mismatch`
   (ADR-031/032, chemin commun inchangé) : rien n'est crédité automatiquement. La finance vérifie, traite
   l'écart chez payment, puis crédite le montant réellement reçu par
   `POST /api/v1/admin/wallet/holders/{type}/{id}/credits` (`kind: top_up`, `paymentId`). La référence
   `payment:<id>` garantit **un seul crédit par paiement**, automatique ou manuel. Raisons : un écart est
   anormal (la page fixe le montant) ; la devise peut être inconnue ; le code critique de confirmation
   reste unique ; la finance a l'outil pour créditer ce qui a été vraiment reçu. Les autres refus
   d'ADR-032 (paiement réussi non enregistré, écart bloquant l'objet) ne s'appliquent pas aux recharges :
   chaque recharge est un argent nouveau, jamais le second paiement d'une même dette.
6. **Débit par les services** (`WalletService.Debit`, `WALLET_DEBIT_CALLERS` = `cleaning,billing`) :
   titulaire, montant, objet (`service` = l'appelant, `object_type`, `object_id`, `part`), libellé lisible,
   clé d'idempotence propre à l'appelant (8 à 150 caractères). **Jamais partiel** : solde insuffisant →
   `WALLET_INSUFFICIENT_FUNDS` (422) avec `details.balance` et `details.missing`. Rejeu d'une clé : le
   même débit ; clé réutilisée pour un autre débit : `WALLET_IDEMPOTENCY_KEY_REUSED` ; débit déjà
   remboursé : `WALLET_DEBIT_REFUNDED` (le client recommence avec une nouvelle clé). `Refund` rembourse en
   entier un débit de l'appelant, une seule fois (index unique de l'écriture inverse) ;
   `GetPrepaidBalance` lit le solde.
7. **Nettoyage** : `POST /api/v1/cleaning/missions/{id}/pay` (`part` = `deposit` ou `balance`,
   `Idempotency-Key`) : cleaning calcule l'acompte encore dû ou le reste dû, wallet le débite (clé
   `<mission>:<part>:<clé du client>`), puis le paiement est enregistré (moyen `wallet`, référence = débit)
   avec les effets d'un paiement enregistré (reste dû, statut, levée d'une suspension). Mission payée ou
   annulée entre-temps : le débit est remboursé aussitôt. **Annulation remboursable** = annulation
   (client dans le délai gratuit, ou supervision) d'une mission dont **aucun passage n'a commencé** : ses
   paiements par portefeuille sont marqués remboursés (`refunded_at`, ne comptent plus dans le payé) et
   `cleaning.mission.refunded` est publié dans la même transaction ; wallet le consomme et rembourse
   chaque débit. Un passage commencé : pas de remboursement automatique (la finance crédite au besoin).
   Les paiements en espèces ou Mobile Money ne sont pas concernés. Le paiement en espèces enregistré par
   le superviseur reste possible.
8. **Factures** : `POST /api/v1/billing/invoices/{id}/pay` (`Idempotency-Key`) : portefeuille de
   l'organisation (membre `org_admin` ou `org_member`) ou du client ; le reste dû est débité en entier
   puis enregistré (moyen `wallet`, auteur = le membre) ; payée au total : `billing.invoice.paid`.
9. **Lecture** : `GET /api/v1/wallet/me` ajoute `prepaid` (solde, dernière écriture) et `topUpLimits` ;
   `GET /api/v1/wallet/me/statement` rend les lignes des deux comptes, chacune avec `account`
   (`collections` | `prepaid`) et `object`, filtrables par `?account=` ; les routes d'ADR-042 restent
   compatibles (champs ajoutés seulement). Back-office : mêmes routes `holders/{type}/{id}` et
   `/statement`, crédit manuel (`finance_officer`, `super_admin`, double authentification ; motif
   obligatoire ; auteur gardé dans l'écriture immuable, qui sert de piste d'audit), vue d'ensemble avec
   les deux nouveaux comptes internes et `owedToCustomers`.
10. **Événements** (outbox de wallet) : `wallet.prepaid.debited`, `wallet.prepaid.credited` (`kind`
    `top_up`|`refund`, `origin` `payment`|`service`|`finance`). notification envoie « paiement effectué
    depuis votre portefeuille » et « portefeuille crédité » (remboursement, crédit de la finance) ; la
    recharge réussie garde le reçu `payment.receipt.customer`, adapté (« la recharge de votre
    portefeuille KSP »). Destinataire : le titulaire, sinon le membre qui a payé ; e-mail de facturation
    pour une organisation ; aucun message pour un crédit de la finance à une organisation.
11. **Paiement Mobile Money direct d'une mission ou d'une facture** (ADR-031) : **déprécié au profit du
    portefeuille**, gardé fonctionnel (`deprecated: true` dans l'OpenAPI) tant que le portail l'utilise.

## Alternatives écartées

- **Même compte que les fonds de créancier** : un créancier pourrait dépenser ses encaissements et un
  client retirer ses recharges.
- **Nouveau service** : le grand livre, ses déclencheurs et ses verrous existent déjà.
- **Créditer automatiquement le montant réellement reçu en cas d'écart** : demanderait une branche
  propre aux recharges dans la confirmation de payment, sans couvrir une devise inconnue ; la finance
  crédite le bon montant en un appel, une seule fois par paiement.
- **Remboursement par appel direct de cleaning à wallet** après l'annulation : une panne entre les deux
  laisserait une mission annulée non remboursée ; l'événement dans la même transaction ne se perd pas.
- **Réservation puis capture du débit** (deux phases) : plus sûr contre un débit orphelin mais beaucoup
  plus de code ; le rejeu par la même clé reprend le débit et l'enregistre.

## Conséquences

- Migrations : wallet `0004_prepaid_wallet`, payment `0006_wallet_top_up` (type réservé aux liens),
  cleaning `0011_wallet_payments` (`refunded_at`). Configuration : `WALLET_DEBIT_CALLERS`,
  `WALLET_TOP_UP_MIN`, `WALLET_TOP_UP_MAX` (wallet) ; `WALLET_GRPC_URL` (cleaning, billing). Jetons de
  service : `cleaning` et `billing` → audience `wallet` ; `wallet` → `payment` (déjà).
- Ordre de déploiement : contrats et wallet, puis payment, puis cleaning et billing, puis gateway et
  notification.
- **Limite connue** : si cleaning ou billing tombe entre le débit et l'enregistrement et que le client
  ne renvoie jamais sa clé, le débit reste sans paiement. Il est visible dans le relevé (objet payé) ;
  un rapprochement planifié des débits non enregistrés est **à faire**.
- **À valider par le responsable** : limites de recharge ; retrait du solde prépayé (clôture du compte,
  suppression ADR-036 : aujourd'hui, le solde ne bloque pas la suppression et n'est jamais reversé) ;
  traitement comptable du prépayé (fonds de tiers, cantonnement, comme ADR-042) ; excédent d'un
  paiement Mobile Money direct crédité au portefeuille plutôt que tracé ; remboursement des missions
  partiellement réalisées.
- Modèles WhatsApp `ksp_wallet_payment` et `ksp_wallet_credit` à faire approuver chez Meta.
