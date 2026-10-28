# ADR-029 — Back-office du Nettoyage : noms lus dans identity à l'affichage, recherche de compte par téléphone dans identity

**Statut** : Accepté (lot 2 ; décisions du responsable du 2026-10-28)

## Contexte

L'essai réel du back-office du Nettoyage a montré deux manques :

1. Les demandes, missions, paiements, grilles, réglages et zones n'affichaient que des identifiants (`customerId`, `organizationId`, `recordedBy`, `updatedBy`). Les noms vivent dans identity (prénom et nom du compte, raison sociale de l'organisation) ; la règle d'or n° 1 interdit à cleaning de lire sa base.
2. Pour rattacher un agent (`POST /api/v1/admin/cleaning/agents`), l'admin devait connaître l'identifiant du compte KSP de la personne. Il ne connaît que son numéro de téléphone.

Deux solutions étaient possibles pour le premier point : lire les noms dans identity au moment de la réponse, ou copier le nom dans cleaning au moment de la demande.

## Décision

1. **Noms lus dans identity à l'affichage, jamais copiés.** cleaning appelle `IdentityService.GetUsersByIds` et `GetOrganizationsByIds` (jeton de service, ADR-022), un appel par lot de 100 identifiants, avec le délai, la nouvelle tentative et le coupe-circuit du `GrpcCaller`. Un membre de l'équipe rattaché comme agent garde le nom de sa fiche agent (celui des passages), sans appel. identity ajoute cleaning à ses appelants autorisés, **sans les coordonnées** : ni téléphone, ni e-mail, ni e-mail de facturation.
2. **Lecture au mieux.** identity indisponible ou appel refusé : les noms manquent (`null` en REST), la réponse du back-office part quand même et l'échec est journalisé sans identifiant de personne. Un nom n'est jamais une raison de refuser d'afficher un dossier.
3. **Champs ajoutés au contrat, facultatifs** : `customerName`, `organizationName` (demandes et missions), `agentName` (visite), `recordedByName` (paiements), `updatedByName` (grille, réglages, zones). Remplis pour le back-office seulement ; `null` dans l'espace client. Les missions reçoivent aussi `customerKind` et `organizationId`, tirés de la mission elle-même.
4. **Recherche de compte dans identity** : `AccountAdminService.FindAccountByPhone`, route `POST /api/v1/admin/identity/accounts/lookup`. Rôles `cleaning_admin` et `super_admin`, double authentification, revérifiés par identity. Elle rend l'identifiant, l'état, le prénom, le nom et le **numéro masqué** (indicatif et deux derniers chiffres) ; jamais l'e-mail ni le numéro complet. Le numéro voyage dans le corps de la requête, pas dans l'adresse, qui est journalisée. Limite propre (`account_lookup`, 20 par minute et par utilisateur) contre l'énumération des numéros. Un compte supprimé est introuvable.

## Alternatives écartées

- **Copier le nom dans cleaning à la demande** : la gateway ne porte pas le nom dans le jeton ; il aurait fallu lire identity de toute façon, au moment de la demande. Le nom copié vieillit (un client qui corrige son nom resterait faux au back-office), les demandes existantes n'auraient pas de nom (rattrapage nécessaire), et cleaning garderait une donnée personnelle de plus, à effacer à la suppression du compte. Les auteurs des paiements et des réglages auraient demandé la même copie. La copie reste la bonne règle pour un document figé, comme l'en-tête d'une facture (ADR-028), pas pour un écran de travail.
- **Enrichissement par la gateway** (appel à identity après la réponse de cleaning) : la gateway deviendrait l'orchestratrice d'un écran métier, contre la règle des façades fines (BFF réservées).
- **Recherche de compte dans cleaning** (cleaning appelant identity) : chaîne gateway → cleaning → identity pour une donnée qui n'appartient qu'à identity ; la recherche servira aussi aux autres métiers et à l'administration des comptes internes.

## Conséquences

- cleaning dépend d'identity pour afficher des noms, pas pour fonctionner. Variables `IDENTITY_GRPC_URL`, `IDENTITY_TOKEN_URL`, `SERVICE_CLIENT_SECRET` dans cleaning ; entrée `cleaning` (audience `identity`) à ajouter à `SERVICE_CLIENTS` d'identity en préproduction et en production.
- Une liste de 100 demandes coûte au plus un appel pour les comptes et un pour les organisations.
- Les autres métiers qui voudront retrouver un compte par numéro s'ajouteront aux rôles de `FindAccountByPhone` ; la recherche n'est pas encore tracée dans le journal d'audit d'identity (à ajouter avec l'administration des comptes internes).
