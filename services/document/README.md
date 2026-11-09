# Service `document`

Documents PDF produits à partir de modèles versionnés, et signature électronique simple par code à usage unique, avec ou sans compte KSP (ADR-044). Contrat gRPC : `contracts/proto/ksp/document/v1/document.proto`. Événement publié : `document.signature.completed` (`contracts/events/document/`). Événement écouté : `identity.user.deleted`. Routes REST (via la gateway) : `/api/v1/document/…`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/document-service prisma:migrate   # crée les tables
pnpm --filter @ksp/document-service dev
```

- gRPC : `localhost:50058` ; santé : `http://localhost:3108/health/live` et `/health/ready` ; métriques : `/metrics`.
- Dépendances : `file` (stockage des PDF, MinIO en local), `notification` (codes et liens : écrits dans son terminal en développement), `identity` (coordonnées d'un signataire titulaire d'un compte).
- Base locale `document` : `docker compose down -v && pnpm infra:up` la crée (`infra/local/postgres-init.sql`).

## Modèles

Un fichier par version dans `src/domain/templates/` ; une version publiée ne change plus (nouvelle version pour tout changement de texte ou de variables). Variables en JSON, validées par un schéma strict (champ inconnu refusé, montants entiers en FCFA, dates `AAAA-MM-JJ`, téléphones E.164) ; une erreur ne cite que les chemins des variables (`DOCUMENT_VARIABLES_INVALID`, `details.fields`), jamais les valeurs.

| Modèle                          | Préfixe | Signature | Services   | Variables principales                                                                                                                         |
| ------------------------------- | ------- | --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `recovery_mandate` v1           | `MAN`   | requise   | `recovery` | `caseReference`, `creditor` (nom, qualité, adresse…), `debtor`, `claim` (principal, cause, échéance), `fees` (honoraires en %), durée en mois |
| `recovery_formal_notice` v1     | `MED`   | jamais    | `recovery` | `caseReference`, `creditor`, `debtor`, `claim` (principal, cause, frais), délai de paiement en jours, modalités de paiement                   |
| `recovery_settlement_agreement` | `PAC`   | requise   | `recovery` | `caseReference`, `creditor`, `debtor`, cause, `agreedTotal`, `installments` (date, montant ; somme = total), modalités, délai de grâce        |
| `generic` v1                    | `DOC`   | possible  | tous       | `title`, `paragraphs` : modèle de test, interdit en production                                                                                |

Textes sobres et génériques, **à faire relire par un juriste** avant la production (ADR-044, « À valider »).

## Rendu PDF

PDFKit (A4, en-tête de l'émetteur et numéro sur chaque page, pied de page avec mentions légales et pagination), polices **Noto Sans embarquées** (`assets/fonts/`, licence OFL), ligatures désactivées (texte copié exact), rendu déterministe. La page de certificat est produite par PDFKit puis ajoutée aux pages d'origine, **recopiées sans modification**, par pdf-lib.

## Signature

| Étape           | Règle                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demande         | Par le service producteur (`RequestSignature`, idempotente) ; un signataire, une demande en attente par document ; 7 jours par défaut. Compte KSP (coordonnées lues dans identity) ou personne sans compte (téléphone, nom, e-mail facultatif). |
| Annonce         | Lien personnel `<PORTAL_BASE_URL>/signer/<jeton>` (sans compte) ou `/mon-espace/documents/<id>` (compte), ou code immédiat (`notice: "code"`). Message non parti : demande retirée, erreur rendue.                                              |
| Code            | 6 chiffres, 10 minutes, 5 essais ; un par minute, 5 par heure et par demande ; empreinte HMAC seule en base ; WhatsApp (modèle d'authentification) puis e-mail vérifié.                                                                         |
| Signature       | Code et accord explicite (`consent: true`) ; PDF stocké relu, empreinte SHA-256 comparée (`DOCUMENT_CONTENT_CHANGED`) ; page de certificat ; PDF signé stocké à part ; preuve et événement en une transaction.                                  |
| Clôture         | Demande échue présentée expirée, close toutes les 10 minutes (`DOCUMENT_EXPIRY_INTERVAL_MS`) ; annulation par le service producteur (jamais d'un document signé).                                                                               |
| Données         | Téléphone et e-mail en clair gardés seulement tant que la demande est en attente ; jamais de code, jeton, téléphone en clair, variable ni contenu dans les journaux.                                                                            |
| Compte supprimé | Demandes en attente annulées, documents gardés et détachés, identifiant du compte retiré des demandes et preuves (nom et téléphone masqués gardés : preuve).                                                                                    |

## Organisation

| Dossier                   | Contenu                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/domain`              | Modèles et leur catalogue, contenu d'un document, certificat, règles des codes, statuts, mise en forme |
| `src/application`         | Cas d'usage (production, demande, codes, signature, lecture, clôture, compte supprimé), ports, erreurs |
| `src/infrastructure/pdf`  | Rendu PDFKit et ajout du certificat (pdf-lib)                                                          |
| `src/infrastructure/file` | Stockage des PDF par `file` (adresses présignées)                                                      |
| `src/infrastructure/…`    | Notification, identity, base (Prisma), secrets, tâche de clôture, outbox                               |
| `src/interfaces`          | Contrôleurs gRPC (interne, espace connecté, lien) et abonnement à `identity.user.deleted`              |

Tests : domaine, cas d'usage (doublures en mémoire), rendu PDF réel ; `test/document.repository.int.spec.ts` contre PostgreSQL (ignoré sans `TEST_DATABASE_URL`).
