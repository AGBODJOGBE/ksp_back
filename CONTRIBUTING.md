# Règles de travail

## Règles d'or d'architecture

1. Une base de données par service ; aucun service ne lit la base d'un autre.
2. Un service = un domaine métier ; on ne découpe pas plus fin sans raison.
3. Contrats versionnés (gRPC, OpenAPI, schémas d'événements) et testés.
4. Ne jamais perdre ni doubler un événement : outbox, inbox, file d'erreurs.
5. Pas de longues chaînes d'appels ; délais, nouvelles tentatives et coupe-circuit partout.
6. Supervision dès le premier jour.
7. Un modèle commun de service (généré par `pnpm new-service`).
8. Sécurité à chaque niveau.
9. Chaque décision importante notée dans un ADR (`docs/adr/`).

## Cycle d'un lot

1. Le cahier des charges du service est validé.
2. Les contrats sont écrits et validés (`contracts/`).
3. Le code est écrit en testant d'abord.
4. Tests de contrat et de bout en bout.
5. Relecture de code.
6. Préproduction, puis validation par le responsable du projet.
7. Mise en production.

**Prêt à développer** : cahier des charges validé et contrats écrits.

**Terminé** : critères d'acceptation couverts par des tests, CI au vert, code relu, documentation et contrats à jour, traces et métriques en place.

## Branches et fusion

- On ne travaille jamais directement sur `main`.
- Une fonctionnalité = une branche, partie d'un `main` à jour, nommée `<type>/<périmètre>-<sujet>` avec les types des messages de commit : `feat/identity-otp-request`, `fix/ci-image-name`, `docs/regles-branches`.
- La branche est poussée puis proposée en demande de fusion (pull request) vers `main` : c'est elle qui déclenche la CI.
- Fusion après CI verte et validation du responsable du projet, en « Squash and merge » : une fonctionnalité = un commit sur `main`, avec un titre au format des messages de commit.
- La branche est supprimée après la fusion.

## Organisation d'un service

| Couche               | Contenu                                                                             | Peut dépendre de        |
| -------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `src/domain`         | Entités, objets-valeurs, règles, machines à états, événements métier                | Rien (TypeScript pur)   |
| `src/application`    | Un cas d'usage par classe (`RequestOtpUseCase` pour UC-ID-01), interfaces des ports | `domain`                |
| `src/infrastructure` | Dépôts Prisma, outbox, clients gRPC sortants, prestataires                          | `application`, `domain` |
| `src/interfaces`     | Contrôleurs gRPC, consommateurs d'événements, tâches planifiées                     | `application`           |

ESLint refuse les imports interdits dans `domain` et `application`.

Un cas d'usage = une classe = au moins un test de ses critères d'acceptation.

## Contrats

- Tout changement d'API ou d'événement commence dans `contracts/`.
- On reste compatible (`pnpm contracts:breaking`) ; sinon on crée une `v2` à côté de la `v1`.
- Après une modification de `.proto` : `pnpm contracts:generate`, et le code généré est committé.
- Un nouvel événement : schéma `contracts/events/<service>/<événement>.v1.schema.json` + type dans `libs/contracts/src/events`.
- Une nouvelle route REST : dans `contracts/openapi/ksp-api.v1.yaml`, avec `x-ksp-grpc` (appel gRPC exécuté), `x-ksp-access` et `x-ksp-rate-limit`, et un exemple par requête et par réponse. Le test de contrat vérifie que l'appel gRPC existe et que chaque exemple respecte son schéma.

## Conventions

| Sujet      | Règle                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Événements | `<service>.<entité>.<action au passé>` (`identity.user.registered`) ; échange `ksp.events` ; file `<consommateur>.<événement>` |
| gRPC       | Paquet `ksp.<service>.v1`, fichier `contracts/proto/ksp/<service>/v1/`                                                         |
| REST       | Uniquement via la gateway : `/api/v1/<service>/...`                                                                            |
| Erreurs    | `{ error: { code, message, details, correlationId } }` ; code `SERVICE_RAISON` en anglais, message en français                 |
| Montants   | Entiers en francs CFA (`XOF`), jamais de nombre à virgule                                                                      |
| Dates      | UTC, format ISO 8601                                                                                                           |
| Téléphones | Format international E.164 (`+229...`)                                                                                         |
| Langue     | Code et contrats en anglais ; documentation en français                                                                        |

## Git

- `main` est protégée : toute modification passe par une demande de fusion avec la CI au vert.
- Une branche par sujet : `feat/identity-otp`, `fix/gateway-rate-limit`.
- Messages au format [Conventional Commits](https://www.conventionalcommits.org/fr/) (vérifiés par commitlint) : `feat(identity): demande de code de vérification`.
- Fusion en un seul commit.
- Une étiquette de version par service : `identity@v1.0.0`.

## Migrations

- Versionnées dans `services/<service>/prisma/migrations`.
- Jamais de retour en arrière : on corrige par une nouvelle migration.
- Changement incompatible en deux temps : ajouter, migrer les usages, puis retirer.
- Appliquées par une tâche de déploiement (`prisma migrate deploy`), jamais au démarrage du service.

## Secrets

Jamais de secret dans le dépôt. Seul `.env.example` décrit les variables attendues ; les valeurs réelles viennent du coffre à secrets au déploiement.

## Kit commun

`libs/platform` ne contient jamais de code métier. Une règle métier partagée par deux services révèle souvent un service manquant ou un événement à publier.

## Outillage personnel

Les fichiers de configuration personnels (outils, assistants, notes locales) ne sont jamais versionnés ni mentionnés dans les commits, demandes de fusion ou README. On les exclut avec `.git/info/exclude` ou l'exclusion globale de git de son poste (`git config --global core.excludesFile`), pas avec le `.gitignore` du dépôt (ADR-016).
