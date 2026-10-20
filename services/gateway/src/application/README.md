# Application

Contrôles de la gateway avant chaque appel (`AuthorizeRequestUseCase`) et cas d'usage exposés
par service (`identity`), avec leurs ports implémentés par la couche infrastructure (client gRPC,
cache des clés publiques, compteurs des limites d'appels).
