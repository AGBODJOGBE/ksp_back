# ADR-038 — Service `file` : envoi direct au stockage par adresse présignée, finalités fermées, droits portés par les services métier

**Statut** : Proposé (2026-11-07)

## Contexte

Des pièces jointes arrivent dans plusieurs domaines : pièces justificatives du Recouvrement, photos des passages du Nettoyage, PDF produits par le futur service `document`, photo de profil. L'ADR-001 prévoit un service socle `file` ; l'ADR-018 retient l'Object Storage compatible S3 de Contabo en production (MinIO en local, `docker-compose.yml`). Il faut stocker ces fichiers sans faire transiter leur contenu par la gateway (corps limité à 1 Mo, ADR-011), en vérifiant ce qui est reçu, avec des droits de lecture qui dépendent des règles métier (le superviseur d'une mission voit ses photos), et en traitant les données personnelles à la suppression d'un compte (ADR-036).

## Décision

1. **Envoi direct au stockage** (aucun octet ne passe par la gateway ni par `file`) :
   - `POST /api/v1/file/uploads` (`FileService.CreateUpload`) : le compte connecté déclare `purpose`, `fileName`, `contentType`, `sizeBytes`. Le fichier est enregistré `pending` et la réponse porte une **adresse PUT présignée** (15 minutes) dont `Content-Type` et `Content-Length` sont **signés** : le stockage refuse un autre type ou une autre taille.
   - `POST /api/v1/file/files/{id}/complete` (`CompleteUpload`) : `file` relit le contenu dans le stockage (présence, taille réelle, type enregistré, **signature binaire** des 16 premiers octets : PDF, JPEG, PNG, WebP), puis l'antivirus. Conforme : `available`. Sinon `rejected` (`size_mismatch`, `type_mismatch`, `malware`), contenu effacé aussitôt, erreur `FILE_UPLOAD_REJECTED` (422). Contenu absent : `FILE_NOT_UPLOADED` (422), le fichier **reste en attente** (le client peut envoyer puis reconfirmer) jusqu'à sa purge — plutôt qu'un rejet définitif sur une confirmation arrivée trop tôt.
2. **Propriétaire et objet métier** : le propriétaire est **toujours le compte connecté** (jamais une valeur du corps). L'objet métier (type + identifiant) n'est **jamais déclaré par le client** : c'est le service responsable qui rattache le fichier (`AttachFile`), en indiquant le compte au nom duquel il agit (`FILE_OWNER_MISMATCH` sinon) : connaître l'identifiant du fichier d'un autre ne suffit pas pour le rattacher à son propre dossier. Un fichier disponible jamais rattaché est purgé après 24 heures.
3. **Finalités** (liste fermée, extensible par ajout dans `src/domain/purposes.ts` et le contrat) :

   | Finalité                      | Types                | Taille max | Envoyé par | Services responsables | Compte supprimé |
   | ----------------------------- | -------------------- | ---------- | ---------- | --------------------- | --------------- |
   | `recovery_evidence`           | PDF, JPEG, PNG, WebP | 10 Mo      | compte     | `recovery`            | gardé, détaché  |
   | `cleaning_intervention_photo` | JPEG, PNG, WebP      | 8 Mo       | compte     | `cleaning`            | gardé, détaché  |
   | `generated_document`          | PDF                  | 20 Mo      | service    | `document`            | gardé, détaché  |
   | `avatar`                      | JPEG, PNG, WebP      | 2 Mo       | compte     | `identity`            | effacé          |

   Ni SVG, ni HTML, ni bureautique : aucun contenu actif servi depuis le stockage.

4. **Droits de lecture** : par la gateway, **seul le propriétaire** lit un fichier (`GET /api/v1/file/files/{id}`, `GET /api/v1/file/files/{id}/download-url`, adresse GET de 5 minutes). Toute autre personne passe par le **service responsable de l'objet**, seul à connaître ses règles : il appelle `FileInternalService.ListFiles` (avec adresses) ou `CreateDownloadUrl` et rend l'adresse à son utilisateur. `file` ne tient **aucune table de droits** : pas de droit périmé à révoquer quand un superviseur change de mission.
5. **Contrat interne** `FileInternalService` (jetons de service, ADR-022) : `CreateServiceUpload` / `CompleteServiceUpload` (PDF produits par `document`, rattachés dès la déclaration), `AttachFile`, `ListFiles`, `CreateDownloadUrl`, `DeleteFile`. Un service ne voit, ne rattache et ne supprime que les fichiers **de ses finalités** et **de ses objets** ; un appelant sans finalité (la gateway) reçoit `FILE_CALLER_FORBIDDEN`.
6. **Limites et quota** : type et taille par finalité ; par compte, 20 envois en attente simultanés et 500 Mo déclarés sur 24 heures glissantes (`FILE_QUOTA_EXCEEDED`, 422) ; la gateway limite la déclaration à 30 par minute et par utilisateur (`file_upload`).
7. **Cycle de vie et purge** (tâche toutes les 10 minutes, par lots de 100, sûre avec plusieurs instances) : envoi non confirmé après 24 heures → supprimé ; disponible jamais rattaché après 24 heures → supprimé ; `DeleteFile` → **suppression logique**, contenu effacé après **7 jours de grâce** (erreur rattrapable par l'exploitation) ; rejeté → ligne retirée après 24 heures. L'effacement physique supprime le contenu puis la ligne ; une panne du stockage laisse la ligne pour le passage suivant.
8. **Compte supprimé** (`identity.user.deleted`, file `file.identity.user.deleted`, idempotent par l'inbox) : envois en attente, fichiers jamais rattachés et finalités `erase` (photo de profil) supprimés avec effacement au passage suivant de la purge. Les autres sont **gardés** car ils relèvent d'une obligation ou d'une preuve : pièces d'une créance (Recouvrement, litiges), preuves de prestation (Nettoyage, contestation et facturation), documents comptables générés (10 ans, OHADA, comme l'ADR-036 pour les factures). Ils sont **détachés** : propriétaire retiré et nom d'origine (souvent nominatif) remplacé par `<id>.<ext>`. Leur suppression relève ensuite du service responsable, selon ses règles de conservation.
9. **Données personnelles et journaux** : ni contenu, ni nom de fichier, ni adresse présignée dans les journaux (compteurs et identifiants seulement) ; aucune erreur du SDK transmise telle quelle (`FILE_STORAGE_UNAVAILABLE`). Clé de stockage `<finalité>/<id>` sans donnée personnelle. Bucket **privé** ; lecture servie `inline` avec le type vérifié.
10. **Antivirus** : point d'extension `MalwareScanner` appelé à la confirmation ; l'adaptateur actuel (`SkipMalwareScanner`) n'analyse rien. Le risque est contenu par les types acceptés (images et PDF), vérifiés à leur signature. Un adaptateur ClamAV (flux `INSTREAM`) ou un service d'analyse se branche sans changer les cas d'usage.
11. **Événements** : aucun publié pour l'instant — aucun consommateur n'en a besoin, le rattachement étant un appel direct du service métier. L'outbox du modèle reste en place pour en ajouter (`file.file.erased`…) quand un service en aura l'usage.
12. **Client S3** : `@aws-sdk/client-s3` et `@aws-sdk/s3-request-presigner` (ajoutés au seul `package.json` du service : bibliothèque officielle, présignature SigV4 et en-têtes signés, compatible MinIO et Contabo). Sommes de contrôle seulement quand l'API les exige (`WHEN_REQUIRED`) : celles ajoutées par défaut par les versions récentes du SDK ne sont pas reconnues par tous les stockages compatibles. Adressage par chemin par défaut ; adresse publique distincte possible (`FILE_STORAGE_PUBLIC_ENDPOINT`) pour signer avec l'hôte vu par les fronts.

## Écarts à la demande

- Routes sous `/api/v1/file/…` (convention `/api/v1/<service>/…`, CONTRIBUTING) au lieu de `/api/v1/files/…`.
- « Propriétaire métier » : le compte vient du jeton, l'objet est fixé par le service responsable (point 2), jamais par le client.

## Alternatives écartées

- **Envoi au travers de la gateway** : corps limité à 1 Mo, mémoire et bande passante de la gateway consommées, sans gain de contrôle (la vérification se fait de toute façon sur le contenu stocké).
- **Formulaire POST présigné avec `content-length-range`** : borne la taille sans la fixer et complique les clients mobiles ; le PUT avec taille signée l'impose exactement.
- **Table de droits de lecture dans `file`** (`GrantAccess`) : droits à synchroniser et révoquer avec les règles métier ; écartée au profit de l'adresse délivrée par le service responsable.
- **Rejet immédiat d'un envoi absent à la confirmation** : une confirmation arrivée avant la fin de l'envoi rendrait le fichier inutilisable.
- **Implémentation de SigV4 à la main** : moins de dépendances, mais une signature maison est une source d'erreurs de sécurité.

## Conséquences

- Production (à faire par l'exploitation) : créer le bucket privé chez Contabo, ses **règles CORS** (PUT et GET depuis les origines des fronts, en-tête `Content-Type`), des clés dédiées au service, vérifier la région de signature et l'adressage par chemin (ADR-018), et ajouter `file` à `SERVICE_CLIENTS` d'identity avec les audiences des appelants (gateway, cleaning, recovery, document, identity).
- Les fronts envoient le contenu avec exactement les en-têtes renvoyés et la taille déclarée, puis confirment.
- Un service métier qui affiche des fichiers d'un objet passe par `ListFiles` / `CreateDownloadUrl` ; s'il supprime un objet, il supprime ses fichiers (`DeleteFile`) selon ses propres règles de conservation.
- Les quotas sont vérifiés sans verrou : deux déclarations simultanées peuvent dépasser la limite d'un fichier (sans conséquence, la limite étant une protection et non une facturation).
