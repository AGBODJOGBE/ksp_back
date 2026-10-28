# Registre des décisions d'architecture (ADR)

Chaque décision importante fait l'objet d'une fiche courte : contexte, décision, alternatives écartées, conséquences (règle d'or n° 9). Une décision n'est jamais modifiée : on la remplace par une nouvelle fiche qui la cite.

| N°                                                      | Décision                                                                                       | Statut  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| [ADR-001](0001-architecture-orientee-services.md)       | Architecture orientée services : 17 services                                                   | Accepté |
| [ADR-002](0002-depots-separes.md)                       | Front et back séparés ; un dépôt backend unique                                                | Accepté |
| [ADR-003](0003-nestjs.md)                               | NestJS (TypeScript) pour tous les services                                                     | Accepté |
| [ADR-004](0004-une-base-par-service.md)                 | Une base PostgreSQL par service                                                                | Accepté |
| [ADR-005](0005-rabbitmq-outbox-inbox.md)                | RabbitMQ pour les événements, avec outbox et inbox                                             | Accepté |
| [ADR-006](0006-grpc-et-gateway.md)                      | gRPC entre services ; REST et WebSocket uniquement via la gateway                              | Accepté |
| [ADR-007](0007-architecture-hexagonale.md)              | Architecture hexagonale dans chaque service                                                    | Accepté |
| [ADR-008](0008-docker-k3s-github-actions.md)            | Docker, k3s et GitHub Actions                                                                  | Accepté |
| [ADR-009](0009-langues.md)                              | Code en anglais, documentation en français                                                     | Accepté |
| [ADR-010](0010-prisma.md)                               | Prisma comme ORM                                                                               | Accepté |
| [ADR-011](0011-traefik-gateway.md)                      | Traefik en entrée du cluster ; gateway en NestJS ; pas de Kong                                 | Accepté |
| [ADR-012](0012-payload-cms.md)                          | Payload CMS pour le service cms                                                                | Accepté |
| [ADR-013](0013-authentification-entre-services.md)      | Authentification entre services                                                                | Accepté |
| [ADR-014](0014-otp-par-grpc.md)                         | Codes de vérification envoyés par appel gRPC direct                                            | Accepté |
| [ADR-015](0015-pas-de-regroupement.md)                  | Pas de regroupement de déploiements                                                            | Accepté |
| [ADR-016](0016-outillage-personnel.md)                  | Outillage personnel non versionné                                                              | Accepté |
| [ADR-017](0017-postgres-et-rabbitmq-en-production.md)   | PostgreSQL géré hors du cluster ; RabbitMQ dans le cluster                                     | Accepté |
| [ADR-018](0018-hebergeur.md)                            | Choix de l'hébergeur : Contabo                                                                 | Accepté |
| [ADR-019](0019-ouverture-aux-partenaires.md)            | Ouverture aux solutions partenaires                                                            | Accepté |
| [ADR-020](0020-cles-de-signature.md)                    | Clés de signature des jetons                                                                   | Accepté |
| [ADR-021](0021-whatsapp-cloud-api.md)                   | WhatsApp par l'API officielle de Meta                                                          | Accepté |
| [ADR-022](0022-jetons-de-service.md)                    | Jetons de service : flux OAuth 2.0 client credentials                                          | Accepté |
| [ADR-023](0023-double-authentification-back-office.md)  | Double authentification du back-office : application et codes de récupération                  | Accepté |
| [ADR-024](0024-email-brevo.md)                          | E-mail par Brevo (API transactionnelle)                                                        | Accepté |
| [ADR-025](0025-facturation-contrats-entreprise.md)      | Facturation des contrats d'entreprise : contrats appris par événements, mois civils au prorata | Accepté |
| [ADR-026](0026-email-du-profil-verifie.md)              | E-mail du profil vérifié par un code envoyé par e-mail                                         | Accepté |
| [ADR-027](0027-comptes-entreprise.md)                   | Comptes entreprise : organisations validées par KSP, membres et contexte actif                 | Accepté |
| [ADR-028](0028-factures-des-entreprises.md)             | Factures des entreprises : en-tête copié à l'émission, e-mail de facturation                   | Accepté |
| [ADR-029](0029-noms-affiches-et-recherche-de-compte.md) | Back-office du Nettoyage : noms lus dans identity, recherche de compte par téléphone           | Accepté |
