/**
 * Double authentification exigée sur le back-office : faite pendant la session en cours, soit au plus
 * 12 heures (durée d'une session back-office, cahier des charges Identité).
 */
export const BACKOFFICE_MFA_SECONDS = 12 * 3600;

/**
 * Actions critiques (rôles, suspension, double authentification, argent) : double authentification
 * de moins de 10 minutes (cahier des charges Identité, partie 4 ; ADR-050). Seul réglage, repris par
 * `x-ksp-mfa-max-age` dans le contrat OpenAPI.
 */
export const CRITICAL_MFA_SECONDS = 600;
