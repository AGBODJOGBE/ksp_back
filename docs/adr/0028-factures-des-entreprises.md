# ADR-028 — Factures des entreprises : en-tête copié à l'émission, e-mail de facturation

**Statut** : Accepté (lot 2 ; décisions du responsable du 2026-10-27)

## Contexte

Depuis l'ADR-027, une organisation a une fiche dans identity (raison sociale, adresse, IFU, RCCM facultatif) et un e-mail de facturation vérifié par code. Mais `billing` émettait les factures sans le nom de l'entreprise, et `notification` les envoyait à l'adresse du compte client qui porte le contrat (`customerId`). L'ADR-027 annonçait une lecture de l'organisation par une RPC interne d'identity.

## Décision

1. **RPC interne `IdentityService.GetOrganizationsByIds`** (jeton de service, 100 identifiants au plus, introuvables omis, tous états rendus) : raison sociale, adresse, IFU, RCCM, état, e-mail de facturation. Ni membres, ni décisions du back-office. Appelants autorisés : `billing` (sans l'e-mail) et `notification` (avec l'e-mail). L'e-mail transmis est toujours vérifié ; identity le revérifie à la lecture (date de vérification).
2. **En-tête copié dans la facture à l'émission** (`billing`, colonnes `organization_*` de `invoices`, migration additive) : une facture est un document comptable, elle ne suit pas les modifications ultérieures de la fiche. Aucun champ fiscal au-delà de l'IFU et du RCCM (pas de TVA). Exposé par les routes factures du client et du back-office (`organization`, `null` pour une facture émise avant).
3. **Pas de facture sans en-tête** : `billing` lit identity au moment d'émettre (délai, nouvelle tentative, coupe-circuit du `GrpcCaller`). identity indisponible → aucune facture émise à ce passage, la tâche planifiée réessaie 15 minutes plus tard ; le passage en « impayée » n'en dépend pas. Organisation introuvable → le contrat est reporté et journalisé à chaque passage (anomalie à corriger à la main). L'échéance part de l'émission réelle.
4. **E-mail des factures d'une organisation** (`notification`, `billing.invoice.*` avec `organizationId`) : l'e-mail part à l'e-mail de facturation vérifié de l'organisation ; sans lui, à l'adresse vérifiée du compte client (ADR-026) ; sinon aucun e-mail. WhatsApp et la notification dans l'espace KSP restent pour le compte client. La règle de canal ne change pas : un document part par e-mail, avec WhatsApp en bascule ou faute d'adresse. Quand la fiche de l'organisation est connue, sa raison sociale suit l'objet de l'e-mail (« Votre facture FAC-2026-000042 — SARL Bénin Propre »), pour une boîte comptable qui sert plusieurs entreprises ; le texte et les modèles WhatsApp ne changent pas.
5. **Suspension et réactivation annoncées** : `identity.organization.suspended` et `.reactivated` reçoivent, par ajout facultatif, `createdBy` ; `notification` prévient le demandeur (WhatsApp, e-mail en bascule, espace KSP) avec le motif de la suspension et le lien vers son espace entreprise. Modèles WhatsApp `ksp_identity_organization_suspended` et `ksp_identity_organization_reactivated` à faire approuver par Meta.

## Alternatives écartées

- **Lire la fiche à l'affichage de la facture** : le nom ou l'adresse affichés changeraient après coup ; une facture ne doit plus bouger une fois émise.
- **Émettre sans en-tête quand identity est indisponible** : facture incomplète, à corriger par un avoir qui n'existe pas encore.
- **Porter l'e-mail de facturation dans les événements de billing** : billing devrait le lire et le stocker, et une adresse changée entre l'émission et l'envoi partirait à l'ancienne boîte.

## Conséquences

- `billing` dépend d'identity pour émettre (règle d'or n° 5 respectée : un appel, délai et coupe-circuit, aucune chaîne). Variables `IDENTITY_GRPC_URL`, `IDENTITY_TOKEN_URL`, `SERVICE_CLIENT_SECRET` ; entrée `billing` (audience `identity`) à ajouter à `SERVICE_CLIENTS` d'identity.
- Les factures émises avant la migration restent sans en-tête.

6. **Suspension d'une organisation et contrats** (décision du responsable, option a) : `cleaning` suspendra les contrats d'une organisation suspendue, avec libération des agents, comme pour les impayés ; `billing` en tiendra compte par les événements de suspension et de reprise de `cleaning` (prorata, ADR-025). Implémenté dans une demande de fusion suivante : d'ici là, une suspension d'organisation n'a aucun effet sur ses contrats ni sur sa facturation.

## Points retenus

- E-mail envoyé à l'adresse de facturation : le compte client ne reçoit alors que la notification dans l'espace (pas de WhatsApp en plus), et le texte salue le prénom du titulaire du contrat.
- Destinataire de la suspension et de la réactivation : le demandeur (`createdBy`). À l'arrivée des invitations, prévenir tous les administrateurs de l'organisation.
