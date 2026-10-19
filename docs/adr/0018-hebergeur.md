# ADR-018 — Choix de l'hébergeur : Contabo

**Statut** : Accepté (décision du porteur du projet, 2026-10-19)

## Contexte

Il faut un hébergeur pour k3s, PostgreSQL et un stockage compatible S3. Critères : PostgreSQL géré, stockage S3, latence depuis le Bénin, coût, localisation des données.

## Décision

**Contabo**, retenu pour son coût. Ce que Contabo fournit et ne fournit pas (vérifié le 2026-10-19 sur le site de Contabo) :

| Besoin                | Chez Contabo                                                           | Conséquence                                                                                                               |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Serveurs              | VPS et serveurs dédiés, accès root, réseau privé, pare-feu, sauvegarde | k3s installé et exploité par nous sur des VPS                                                                             |
| PostgreSQL            | **Pas d'offre gérée** (hébergement de bases « auto-géré » uniquement)  | Variante de repli de l'ADR-017 : **CloudNativePG** dans le cluster, sauvegardes vers le stockage objet                    |
| Kubernetes            | **Pas d'offre gérée**                                                  | k3s comme prévu (ADR-008), à installer, mettre à jour et surveiller nous-mêmes                                            |
| Stockage S3           | Object Storage compatible S3, trafic non facturé                       | Utilisé par `file` et pour les sauvegardes                                                                                |
| Coffre à secrets, KMS | Aucun                                                                  | Secrets k3s chiffrés au repos, versionnés chiffrés dans `ksp-infra` ; le port signataire (ADR-020) reste prêt pour un KMS |
| Localisation          | Europe, Royaume-Uni, États-Unis, Asie ; aucun site en Afrique          | Région européenne recommandée pour la latence depuis le Bénin (à valider)                                                 |

## À valider

- Région : un datacenter européen (le plus proche du Bénin en latence).
- Taille du cluster de départ : nombre et gabarit des VPS (3 nœuds recommandés pour tolérer la panne d'un serveur).
- Outil de chiffrement des secrets dans `ksp-infra` (SOPS ou Sealed Secrets).
- Règles béninoises de protection des données : conditions d'un hébergement des données personnelles hors du Bénin.
- Vérifier avec Contabo la compatibilité S3 de l'Object Storage avec nos outils (adressage des buckets).

## Alternatives écartées

- **Hébergeurs avec PostgreSQL et Kubernetes gérés** (DigitalOcean, Scaleway, OVHcloud, grands fournisseurs) : moins d'exploitation pour l'équipe, mais un coût plus élevé ; écartés par le porteur du projet.

## Conséquences

- L'exploitation repose sur l'équipe : mises à jour des serveurs et de k3s, sauvegardes et restaurations testées chaque mois, supervision (règle d'or n° 6).
- PostgreSQL tourne dans le cluster avec CloudNativePG (ADR-017, variante de repli) : réplication, bascule automatique et sauvegardes continues vers l'Object Storage.
- Débloque la préproduction : adresses (`api.ksp.bj`, `api.staging.ksp.bj`) à créer chez le registraire du domaine, derrière Cloudflare (ADR-011).
