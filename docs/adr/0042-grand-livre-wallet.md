# ADR-042 — Service `wallet` : grand livre en double entrée des fonds des clients

**Statut** : Proposé (préalable au Recouvrement, 2026-11-07)

## Contexte

KSP encaisse des sommes pour le compte de ses créanciers (Recouvrement), prélève sa commission et leur
reverse le reste. Il faut savoir à tout moment ce qui est dû à chacun, ce que KSP a gagné et ce qui est
en cours de versement, sans qu'un solde puisse être modifié à la main, et que le créancier suive ses
encaissements et reversements dans son espace. `payment` encaisse et reverse (ADR-031, 040, 041) ;
`recovery` (pas encore écrit) pilotera les dossiers et décidera quand créditer et reverser.

## Décision

1. **Nouveau service `wallet`** (`pnpm new-service`, gRPC 50057, HTTP 3107 : 50056 et 3106 sont pris par
   `file`), base `wallet`, hexagonal, outbox et inbox du modèle.
2. **Grand livre en double entrée** : chaque opération est une transaction de lignes (compte, sens,
   montant entier XOF > 0) **équilibrée**, vérifiée par l'application puis **par la base à la validation**
   (déclencheur différé). Transactions et lignes sont **immuables** (mise à jour et suppression refusées
   par la base) : une erreur se corrige par une **écriture inverse**. Les **soldes ne sont jamais
   saisis** : un déclencheur les met à jour à chaque ligne, sous verrou du compte, et note
   `balance_after` sur la ligne (relevé).
3. **Comptes** : un par titulaire, `holder:user:<id>` ou `holder:organization:<id>` (créé à la première
   écriture ; ce que KSP lui doit) ; comptes internes `ksp:collections` (fonds encaissés et détenus, sens
   débit), `ksp:commission` (commissions acquises), `ksp:payouts_in_transit` (reversements demandés, pas
   encore confirmés). Invariant : collections = Σ titulaires + commission + en transit.
4. **Opérations** (`WalletService`, appelants `WALLET_LEDGER_CALLERS`, `recovery` au lancement) :
   - `RecordCollection` : D collections (brut) / C titulaire (net) / C commission. **Taux fourni par
     l'appelant en points de base** (0 à 10 000 ; 1 250 = 12,5 %) ; commission = brut × taux / 10 000
     **arrondie à l'entier inférieur** (KSP ne prélève jamais plus que le taux, le franc restant va au
     titulaire). Idempotent par (appelant, référence), par exemple `payment:<id du paiement>`.
   - `RequestPayout` : D titulaire / C en transit, **jamais au-delà du solde disponible** (contrôlé sous
     verrou du compte), et le reversement créé dans la même transaction ; puis transmis à payment
     (`PayoutService.RequestPayout`, clé et référence = identifiant du reversement wallet). payment
     injoignable : `pending_submission`, retransmis toutes les minutes. Le numéro complet et le nom du
     bénéficiaire ne sont gardés que jusqu'à la transmission (contrainte en base), ensuite masqués.
   - `payment.payout.completed` : D en transit / C collections ; `payment.payout.failed` : D en transit /
     C titulaire (montant rendu). Inbox dans la même transaction : un événement n'a qu'un effet. Une issue
     arrivée avant que la transmission soit notée s'applique quand même.
   - `ReverseTransaction` : annulation d'un **encaissement** par ses lignes inversées (commission rendue),
     une seule fois, idempotente par référence. Le solde peut devenir **négatif** si l'encaissement a déjà
     été reversé (KSP a trop reversé) : aucun reversement n'est alors possible.
   - `GetBalance`, `ListStatement` : lecture pour l'appelant.
5. **Lecture** : `GET /api/v1/wallet/me`, `/me/statement`, `/me/payouts` pour le titulaire connecté (son
   organisation active, sinon son compte) ; back-office `GET /api/v1/admin/wallet/holders/{type}/{id}`,
   `…/statement`, `/admin/wallet/payouts`, `/admin/wallet/overview` (**`finance_officer`, `super_admin`**,
   double authentification). Lecture seule : aucune écriture par REST.
6. **Contrat interne pour `recovery`** (aucun appel direct aujourd'hui, il n'existe pas encore) : à la
   réception de `payment.link.paid` d'une échéance, `RecordCollection` (titulaire = créancier, brut =
   montant payé, taux du dossier, référence `payment:<paymentId>`) ; à la décision de reverser,
   `RequestPayout` (clé propre au dossier et à l'opération) ; pour corriger, `ReverseTransaction`.
   Jetons de service : `recovery` → `wallet` et `payment`, `wallet` → `payment`, `gateway` → `wallet`.

## Alternatives écartées

- **Solde dans une colonne modifiée par l'application** : erreurs et concurrence invisibles ; ici la base
  dérive le solde des lignes et refuse toute modification.
- **Solde recalculé à chaque lecture** (somme des lignes) : correct mais coûteux, et le contrôle « pas au
  delà du solde » demanderait de verrouiller toutes les lignes.
- **Taux en pourcentage décimal** : flottants ; les points de base gardent des entiers exacts.
- **Arrondi au plus proche** : KSP prélèverait parfois plus que le taux annoncé.
- **wallet écoutant `payment.link.paid`** : il ne connaît ni le créancier ni le taux ; c'est `recovery`
  qui décide.

## Conséquences

- Migration `0003_ledger` : tables, déclencheurs (solde, équilibre différé, immuabilité), comptes
  internes. Configuration : `WALLET_LEDGER_CALLERS`, `PAYMENT_GRPC_URL`,
  `WALLET_PAYOUT_SUBMIT_INTERVAL_MS` ; `IDENTITY_TOKEN_URL` et `SERVICE_CLIENT_SECRET` obligatoires en
  production. Gateway : `WALLET_GRPC_URL`.
- Une écriture n'est jamais supprimée : la purge des données d'un compte supprimé (ADR-036) ne touche
  pas le grand livre (pièce comptable) ; aucune donnée personnelle n'y figure hors du numéro, masqué.
- **À valider par le responsable** : **compte séparé pour les fonds des clients** — les sommes dues aux
  créanciers (`Σ titulaires` + en transit) doivent-elles être tenues sur un compte bancaire ou Mobile
  Money distinct des fonds propres de KSP (cantonnement), et le grand livre doit-il refléter ce compte
  (compte interne dédié, rapprochement avec ses relevés) ? Question juridique et bancaire ouverte.
- **À valider** : qui peut déclencher un reversement (recovery automatiquement, ou la finance au
  back-office) et à quel rythme ; traitement d'un solde négatif (retenue sur les prochains encaissements,
  demande de remboursement) ; rapprochement périodique `ksp:collections` / relevés FedaPay.
