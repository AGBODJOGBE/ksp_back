# ADR-060 — Service `recovery` et circuit de l'argent du recouvrement

**Statut** : Accepté (2026-11-20). Plan et décisions validés par le responsable le 20/11/2026.

## Contexte

Le cahier des charges « Recouvrement et gestion locative » (19/11/2026, points ouverts tranchés le
même jour) décrit le recouvrement de créances B2B, B2C et de loyers confié à KSP : soumission d'un
dossier avec mandat et frais, examen de recevabilité, procédure graduée (notification, échéancier,
relance amiable, mise en demeure, huissier, judiciaire), espace du débiteur sans compte, huissiers et
avocats partenaires, encaissement par KSP, commission et reversement au créancier.

Le socle a déjà été préparé pour ce service : lien de paiement sans compte avec `recovery` comme
émetteur (ADR-040), grand livre avec `RecordCollection`, `RequestPayout` et `ReverseTransaction`
réservés à `recovery` (ADR-042), portefeuille prépayé débité par les services (ADR-046), modèles
`recovery_mandate`, `recovery_formal_notice` et `recovery_settlement_agreement` et signature par
code d'une personne sans compte (ADR-044), finalité de fichier `recovery_evidence` (ADR-038),
obligation `open_recovery_case` (`obligation.proto`, ADR-036).

Le contrôle d'accès par permissions portées par le jeton et la portée `zone` (ADR-057) sont décidés
sur la branche de la refonte v2 du Nettoyage, pas encore fusionnée. Le service suit ce modèle dès
qu'il est disponible (décision 13).

## Décision

1. **Nouveau service `recovery`** (`pnpm new-service recovery` au lot suivant) : gRPC **50060**,
   HTTP interne **3110** (premiers ports libres du registre `tools/services.json`), base `recovery`,
   architecture hexagonale du modèle, outbox et inbox. Contrat `ksp.recovery.v1`
   (`contracts/proto/ksp/recovery/v1/recovery.proto`) : `RecoveryCreditorService`,
   `RecoveryDebtorService`, `RecoveryPartnerService`, `RecoveryAdminService`, tous réservés à la
   gateway, et `ksp.common.v1.ObligationService` réservé à identity.
2. **Types de dossier** `b2b`, `b2c`, `rent`. Les dossiers de loyers sont prévus dans le modèle dès le
   départ (type, nature `rent`, source `rental`) ; leur procédure propre (délai légal d'un mois après
   la mise en demeure, référé, partie 9 du cahier des charges) est livrée avec le lot G de
   l'immobilier locatif.
3. **États** (partie 16.3) — dossier : `draft` → `awaiting_fee` → `under_review` ⇄ `info_requested`
   → `active` → `closed`, `under_review` → `rejected`, `active` ⇄ `suspended` (contestation) ;
   étape : `notice` → `payment_plan` → `amicable` → `formal_notice` → `bailiff` → `litigation`,
   `notice` → `amicable` sans réponse, sauts tracés seulement pour une prescription proche ou un
   risque de disparition des biens, avec l'accord du créancier (R-PR-03). Toute autre transition :
   `RECOVERY_INVALID_TRANSITION`. Les étapes 5 et 6 ne démarrent qu'après l'acceptation en ligne d'un
   devis et le paiement de la provision (R-PR-04).
4. **Montant dû tenu à jour** : principal + intérêts et pénalités du contrat + frais de procédure
   refacturables − payé − remise. **Imputation** d'un encaissement : frais de procédure, puis intérêts
   et pénalités, puis principal (R-EN-03, décision 5 du 19/11).
5. **Commission calculée par `recovery`** selon la règle figée dans le mandat (ADR-062) : par étape
   atteinte, par palier (progressif, sur le cumul encaissé), fixe ou en pourcentage. Le **maximum**
   s'applique à chaque encaissement ; le **minimum** s'applique **au cumul du dossier** : une
   commission minimale par dossier, complétée sur les encaissements suivants, jamais exigée de
   chaque versement d'un échéancier. Le taux unique de
   `RecordCollection` ne suffit pas : le contrat de `wallet` reçoit, **par ajout**, un champ
   facultatif `commission_amount` qui remplace le calcul par le taux quand il est renseigné (0 au
   montant brut). `commission_rate_bps` reste fourni pour le relevé (taux effectif).
6. **Crédit au créancier dès l'encaissement confirmé** : `RecordCollection` (titulaire = créancier,
   référence `payment:<id>` ou `offline:<id>`) crédite le net tout de suite ; le délai de 5 jours
   ouvrés de R-CO-03 est donc toujours tenu. Le retrait de ce solde vers Mobile Money ou un compte
   bancaire (UC-RC-09, R-CO-04) passe par la **demande de retrait de `wallet`**, étendue au solde des
   encaissements : même traitement par la finance, même deuxième validation ; aucune route de
   `recovery` ne relaie `RequestPayout`.
7. **Paiement du débiteur par lien** (ADR-040) : chaque montant choisi par le débiteur (totalité ou
   montant libre) devient un objet payable `PaymentRequest` de `recovery` (`subjectType`
   `recovery_payment_request`), avec un lien de ce montant, **plafonné au montant dû** ; un lien
   précédent non payé est révoqué avant la création (un seul lien payable par objet). `recovery`
   écoute `payment.link.paid`, impute et enregistre l'encaissement.
8. **Paiements hors ligne** (espèces au guichet, virement) : saisis par la finance, validés par une
   autre personne (`RECOVERY_APPROVAL_BY_REQUESTER`, R-AR-03), double authentification de moins de
   10 minutes. **Encaissement déclaré par un partenaire** (R-HU-05) : le partenaire le déclare
   depuis son accès, **sans double authentification** ; il attend la somme virée à KSP, que la
   finance rapproche et valide avec une deuxième personne, comme un paiement hors ligne. Dans les
   deux cas, l'encaissement n'est imputé et crédité qu'à la validation.
9. **Trop-perçu** : évité par le plafond des liens ; un trop-perçu résiduel (hors ligne, partenaire,
   paiements simultanés) est noté sur le dossier et **remboursé à la main par la finance**, qui trace
   la référence du remboursement (`RecordOverpaymentRefund`). Aucune sortie d'argent automatique vers
   un débiteur, qui n'a pas de portefeuille.
10. **Frais de dossier et provisions** débités du portefeuille prépayé du créancier (`wallet.Debit`,
    ADR-046) : solde insuffisant → `RECOVERY_INSUFFICIENT_FUNDS` (montant manquant), recharge, puis
    nouveau débit avec la même clé. **KSP n'avance jamais de frais de procédure** : tout passe par la
    provision du créancier ; un dépassement donne lieu à une nouvelle provision. La ligne « frais
    avancés par KSP » de R-CO-03 disparaît. Les provisions sont tenues sur un compte interne de
    `wallet`, **`ksp:recovery_provisions`** ; les honoraires sont rapprochés avec la provision. Le
    reste d'une provision est **rendu à la main par la finance** tant que le crédit partiel
    (`Credit`) du socle v2 n'est pas disponible (`wallet.Refund` ne rend qu'un débit entier).
    Un dossier refusé, ou **classé faute de complément** (`rejected`, motif `incomplete`), est
    remboursé de ses frais **moins le forfait d'étude**.
11. **Factures de commission** émises par `billing` (R-CO-05) : facture mensuelle par créancier, à
    partir de `recovery.payment.collected` (commission retenue sur l'encaissement : `deducted` ;
    paiement reçu directement par le créancier : `invoiced`, à régler par lui). Reçu des frais de
    dossier émis par `billing`. Relevé mensuel par dossier produit par `document`.
12. **Documents** : courriers et pièces PDF versionnés dans le code de `document` (ADR-044), relus par
    l'avocat avant la production ; pas d'éditeur de courriers au back-office. Cinq modèles s'ajoutent
    aux trois d'ADR-044 (décision 1), tous en v1, produits par `recovery` seul :
    `recovery_settlement_certificate` (ATS, sans signature), `recovery_fee_quote` (DEV, signature
    facultative : devis accepté en ligne par le créancier), `recovery_evidence_log` (JDP, sans
    signature), `recovery_statement` (REL, sans signature), `recovery_receipt` (RCU, sans signature).
    Le journal de preuve est plafonné, par export, à 1 000 entrées et à 750 Ko de variables JSON (la
    première limite atteinte s'applique) ; au-delà, `recovery` le découpe par période (variable
    `part` = { index, total, from, to }, affichée « partie n/m »). `recovery` appelle
    `GenerateDocument` pour ce modèle avec une échéance gRPC propre de 15 s, au lieu des 3 s par
    défaut. Seuls les textes des SMS et e-mails seront modifiables au back-office (modèles
    `recovery.*` de `notification`) ; les messages WhatsApp restent des modèles approuvés par Meta.
13. **Contrôle d'accès** : rôles livrés par défaut `recovery_agent`, `recovery_supervisor`,
    `legal_officer`, `recovery_admin`, et rôles partenaires `recovery_bailiff`, `recovery_lawyer` ;
    `finance_officer` et `super_admin` du socle. Le contrat de la gateway déclare des rôles par route
    (seul modèle de `main`) ; à la fusion d'ADR-057, chaque route passe à une permission
    (`recovery.case.read`, `recovery.case.work`, …, partie 3 du cahier des charges) et la portée
    `zone` limite le superviseur (R-AR-01). Un chargé ne voit que ses dossiers ; un partenaire que ses
    assignations, avec les seules pièces de sa mission (R-AR-02) : chaque pièce porte un indicateur
    « visible du partenaire », posé pièce par pièce par le juriste (livré en R5, sans changement du
    contrat maintenant) ; hors périmètre : 404. Double authentification de la session (12 h) sur le
    back-office, dont la création et la modification d'une règle tarifaire et les jours fériés ; de
    moins de 10 minutes pour les actions sensibles (paiement hors ligne, publication, validation et
    archivage d'une règle tarifaire, assignation d'un partenaire, réglages).
14. **Données personnelles** : coordonnées des débiteurs chiffrées en base (AES-GCM ; le chiffreur
    d'identity rejoint `@ksp/platform` au lot suivant, c'est du code technique), avec une **empreinte
    HMAC du téléphone** pour repérer les dossiers semblables sans déchiffrer (R-SD-06). Un numéro du
    Bénin à 8 chiffres est converti au format actuel, **+229 01 suivi des 8 chiffres**, à la saisie,
    à l'import et avant le calcul de l'empreinte : l'ancien et le nouveau format d'un même numéro
    donnent la même empreinte. Jamais dans
    les journaux, les traces ni les événements (identifiants et montants seulement). Les messages au
    débiteur partent par appel direct à `notification.SendNotification` avec son téléphone, comme les
    codes de signature (ADR-044) : ce qui répond au point ouvert « débiteurs sans compte ».
    Conservation des dossiers clos : 5 ans, réglable.
15. **Journal de preuve en ajout seul** (R-PR-08) : chaque action horodatée et attribuée ;
    modification et suppression refusées par la base ; export PDF. **Journal d'audit local** (comme
    `cleaning`, faute de service `audit`) : consultation d'un dossier, export, téléchargement d'une
    pièce, changement d'étape, paiement hors ligne, reversement.
16. **Délais** : **jours ouvrés du lundi au vendredi**, hors jours fériés du Bénin (table tenue au
    back-office) ; heure du Bénin. **Plages de contact** (8 h – 19 h, lundi – samedi, réglables : le
    samedi reste un jour de contact, sans être un jour ouvré) :
    un message automatique hors plage est différé, un contact manuel hors plage est refusé
    (`RECOVERY_CONTACT_OUTSIDE_HOURS`). Réglages de la partie 17.1 avec leurs bornes.
17. **Tâches planifiées** (modèle des échéances de `cleaning`, verrouillage `SKIP LOCKED`) :
    avancement des étapes à l'échéance, rappels et échéances manquées, promesses non tenues, drafts
    non payés supprimés, décisions expirées, alerte de prescription (90 jours), partenaires sans
    nouvelles depuis 15 jours, relevés mensuels.
18. **Événements publiés** (identifiants et montants seulement) : les onze de la partie 16.5 —
    `recovery.case.submitted`, `.accepted`, `.rejected`, `.stage_changed`, `.suspended`, `.closed`,
    `recovery.plan.signed`, `.defaulted`, `recovery.payment.collected`, `recovery.remittance.paid`,
    `recovery.partner.assigned` — et six de plus pour les notifications de la partie 17.2 :
    `recovery.case.info_requested`, `recovery.case.resumed`, `recovery.decision.requested`,
    `recovery.plan.installment_missed`, `recovery.notice.issued`, `recovery.partner.act_recorded`.
    **Événements écoutés** (déclarés dans `EVENT_CONSUMERS` avec le code) : `payment.link.paid`,
    `document.signature.completed` (mandat, échéancier), `identity.user.deleted`, plus tard
    `rental.rent.overdue` (lot G).
19. **Import tableur** (R-SD-01, 02) : finalités `recovery_import` (XLSX, CSV, 5 Mo) et
    `recovery_evidence_archive` (ZIP, 50 Mo, décompressé par `recovery` avec des limites de taille et
    de nombre de fichiers) ajoutées à `file` avec l'import.

## Alternatives écartées

- **Commission par un taux unique** : ne sait pas rendre les paliers ni les bornes ; recalculer un
  taux équivalent donnerait un arrondi faux.
- **Lien de paiement de montant libre dans `payment`** : changerait ADR-040 (montant fixe, un lien par
  objet) ; un objet `PaymentRequest` par montant garde ce contrat.
- **Remboursement automatique du trop-perçu** : un débiteur n'a pas de portefeuille ; un reversement
  vers un numéro saisi par lui serait une sortie d'argent sans contrôle.
- **Avance des frais de procédure par KSP** : risque de trésorerie et de créance sur le créancier.
- **Éditeur de courriers au back-office** : des textes juridiques modifiés sans relecture.
- **Débiteurs dans `identity`** : voir ADR-061.

## Conséquences

- **Rendu du journal de preuve** : le rendu PDF est synchrone et bloque le service `document` le temps
  d'un export (quelques secondes au pire cas). Le rendu dans un thread séparé est prévu si les
  exports deviennent fréquents.
- **Contrats** (cette branche) : `recovery.proto`, routes `/api/v1/recovery/…`,
  `/api/v1/recovery/debtor/…`, `/api/v1/recovery/partner/…`, `/api/v1/admin/recovery/…`, 17 schémas
  d'événements ; ajouts à `wallet.proto` (`commission_amount`), à `document.proto` (cinq modèles) et à
  `file.proto` (deux finalités prévues) ; sept limites d'appels de la gateway.
- La gateway refuse toute route absente de son manifeste : le test de parité contrat / manifeste échoue
  tant que les routes du recouvrement ne sont pas branchées. Elles le sont lot par lot (R1 à R5), et la
  branche des contrats n'est fusionnée qu'avec la première d'entre elles.
- **Jetons de service** (ADR-022) : `recovery` → `wallet`, `payment`, `document`, `file`,
  `notification`, `identity`, `geo` ; `gateway` et `identity` (obligations) → `recovery`. `recovery`
  ajouté à `PAYMENT_LINK_ISSUERS`, `WALLET_LEDGER_CALLERS`, `WALLET_DEBIT_CALLERS`,
  `DOCUMENT_INTERNAL_CALLERS`.
- **Meta** : modèles WhatsApp du recouvrement à faire approuver (notification du mandat, relances,
  rappels d'échéance, code d'accès du débiteur sur le modèle `ksp_otp`).
- **Préalables au lancement** (partie 18) : compte bancaire dédié aux fonds des clients, revue par un
  avocat béninois (mandat, courriers, délais de prescription, imputation, règles de contact),
  formalités APDP.
- **Corrections du cahier des charges** :
  1. ADR-019 est déjà pris (ouverture aux partenaires) : le recouvrement prend ADR-060 à 062 ; la
     création de `rental` recevra le prochain numéro libre.
  2. Partie 16.4 : routes du back-office en `/api/v1/admin/recovery/…` (convention d'ADR-054, D3),
     non `/api/v1/recovery/admin/…`.
  3. Partie 16.1 : l'accès par lien sécurisé du débiteur est porté par `recovery`, pas par
     `identity` (ADR-061).
  4. Principe 6 et UC-RC-25 : les courriers PDF ne sont pas paramétrables au back-office ; seuls les
     textes des SMS et e-mails le sont.
  5. R-CO-03 : plus de « frais de procédure avancés par KSP » (décision 10) ; crédit dès
     l'encaissement confirmé (décision 6).
  6. Partie 16.5 : six événements ajoutés (décision 18).
  7. Partie 16.4 : `POST /cases/{id}/mandate/sign` devient `POST /cases/{id}/mandate` (préparation et
     code), la signature passant par la route de `document` ; `POST /payment-plans/{id}/sign` du
     débiteur devient l'envoi du lien de signature de `document`.
  8. Partie 4.4 : un dossier « classé » faute de complément est un refus (`rejected`, motif
     `incomplete`), la partie 16.3 n'ayant pas d'état propre ; R-PR-03 : le saut d'étape passe par une
     décision `stage_skip` du créancier.

## À valider

- Paiement des honoraires d'un partenaire depuis la provision : crédit à son portefeuille, ou
  virement par la finance.
- Montant du forfait d'étude retenu sur les frais d'un dossier refusé ou classé faute de complément.
- Durée de la session débiteur (30 minutes proposées) et durée de conservation des pièces envoyées
  par un débiteur dont la contestation est rejetée.
- Délais de prescription par nature de créance (avocat).
