/**
 * Segments d'adresse qui sont des secrets : jeton d'un lien de signature (ADR-044) ou d'un lien de
 * paiement (ADR-040). Ils sont remplacés par « [masqué] » dans les journaux (adresse et paramètres
 * de route) et dans les attributs d'adresse des traces (ADR-051). Chemin seul ou adresse complète.
 * Module sans dépendance : chargé par les traces, avant NestJS.
 */
const SECRET_PATHS: readonly RegExp[] = [
  /(\/api\/v1\/document\/sign\/)[^/?#]+/,
  /(\/api\/v1\/payment\/links\/)[^/?#]+/,
];

export function maskSecretPaths(url: string | undefined): string | undefined {
  return url === undefined
    ? url
    : SECRET_PATHS.reduce((acc, pattern) => acc.replace(pattern, '$1[masqué]'), url);
}
