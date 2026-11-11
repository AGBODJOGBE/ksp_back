# Service `file`

Stockage sécurisé des pièces jointes (ADR-038) : pièces justificatives du Recouvrement, photos des passages du Nettoyage, PDF produits par `document`, photo de profil. Le contenu ne transite jamais par la gateway ni par ce service : il est envoyé et lu directement dans le stockage compatible S3 (MinIO en local, Object Storage de Contabo en production, ADR-018) par des adresses présignées de courte durée.

Contrat gRPC : `contracts/proto/ksp/file/v1/file.proto`. Routes REST (gateway) : `/api/v1/file/…`.

## Démarrer en local

```bash
pnpm infra:up                                     # PostgreSQL, RabbitMQ, MinIO…
cp .env.example .env                              # FILE_STORAGE_CREATE_BUCKET=true crée le bucket ksp-files
pnpm --filter @ksp/file-service prisma:deploy     # crée les tables
pnpm --filter @ksp/file-service dev
```

- gRPC : `localhost:50056` ; santé `http://localhost:3106/health/live` et `/health/ready` (base, RabbitMQ, stockage) ; métriques `/metrics`.
- Console MinIO : http://localhost:9001 (ksp / ksp-local-secret).

## Parcours d'envoi

1. `POST /api/v1/file/uploads` `{ purpose, fileName, contentType, sizeBytes }` → `{ file, upload: { url, method: "PUT", headers, expiresAt } }`.
2. Le front envoie le contenu : `PUT upload.url` avec exactement `upload.headers` (`Content-Type`) et la taille déclarée (type et taille sont signés : le stockage refuse autre chose).
3. `POST /api/v1/file/files/{id}/complete` → `available` ; sinon `FILE_UPLOAD_REJECTED` (taille, type ou signature binaire différents) ou `FILE_NOT_UPLOADED` (contenu pas encore reçu : renvoyer puis reconfirmer).
   L'adresse présignée vise une clé de dépôt `incoming/<id>` : le contenu y est vérifié, puis copié côté stockage sous la clé du fichier à la condition qu'il n'ait pas changé (ETag), et le dépôt est effacé (ADR-050). Un nouvel envoi à l'adresse présignée, encore valable quelques minutes, ne remplace jamais un contenu vérifié ; remplacé pendant la vérification, il n'est pas publié (`FILE_NOT_UPLOADED`). Exploitation : une règle de cycle de vie du bucket (expiration à 1 jour sur `incoming/`) efface les dépôts orphelins.
4. Le front transmet l'identifiant au service métier concerné, qui le rattache à son objet (`FileInternalService.AttachFile`). Un fichier jamais rattaché est purgé après 24 heures.

Lecture : le propriétaire par `GET /api/v1/file/files/{id}` et `GET /api/v1/file/files/{id}/download-url` (5 minutes) ; toute autre personne par le service responsable de l'objet (`ListFiles`, `CreateDownloadUrl`), seul juge de ses droits.

## Finalités

| Finalité                      | Types                | Taille | Services   | Compte supprimé |
| ----------------------------- | -------------------- | ------ | ---------- | --------------- |
| `recovery_evidence`           | PDF, JPEG, PNG, WebP | 10 Mo  | `recovery` | gardé, détaché  |
| `cleaning_intervention_photo` | JPEG, PNG, WebP      | 8 Mo   | `cleaning` | gardé, détaché  |
| `generated_document`          | PDF                  | 20 Mo  | `document` | gardé, détaché  |
| `avatar`                      | JPEG, PNG, WebP      | 2 Mo   | `identity` | effacé          |

Ajouter une finalité : `src/domain/purposes.ts`, commentaire de `file.proto`, énumération `FilePurpose` du contrat OpenAPI et schéma de la gateway.

## Tâches de fond

- Purge (`FILE_PURGE_INTERVAL_MS`, 10 minutes) : envois non confirmés (24 h), fichiers jamais rattachés (24 h), effacement physique des fichiers supprimés après le délai de grâce (7 jours) et des rejetés.
- `identity.user.deleted` (file `file.identity.user.deleted`) : effacement ou détachement selon la finalité (ADR-036, ADR-038).

## Antivirus

Point d'extension `MalwareScanner` (`src/application/ports.ts`), appelé à chaque confirmation. L'adaptateur actuel n'analyse rien (`SkipMalwareScanner`) ; un adaptateur ClamAV ou un service d'analyse se branche dans `app.module.ts`.

## Organisation

| Dossier              | Contenu                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `src/domain`         | Finalités, cycle de vie, nettoyage des noms, signatures binaires            |
| `src/application`    | Cas d'usage (envoi, confirmation, lecture, rattachement, purge, effacement) |
| `src/infrastructure` | Prisma, stockage S3, antivirus, purge planifiée                             |
| `src/interfaces`     | Contrôleurs gRPC, consommateur `identity.user.deleted`                      |

Tests : `pnpm --filter @ksp/file-service test` (stockage simulé en mémoire) ; tests d'intégration du dépôt avec `TEST_DATABASE_URL`.
