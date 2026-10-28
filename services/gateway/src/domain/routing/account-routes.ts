import { BACKOFFICE_MFA_SECONDS } from './cleaning-routes';
import { type RouteDefinition } from './route-manifest';

const ACCOUNT_ADMIN = 'ksp.identity.v1.AccountAdminService';

/** Recherche de compte au back-office (ADR-029) : rattacher un agent du Nettoyage à son compte KSP. */
const ACCOUNT_LOOKUP = ['cleaning_admin', 'super_admin'] as const;

/**
 * Routes des comptes au back-office. Reprises des extensions x-ksp-* du contrat OpenAPI ; le test de
 * conformité vérifie qu'elles restent identiques.
 */
export const ACCOUNT_ROUTES = [
  {
    // Numéro dans le corps, jamais dans l'adresse : les adresses des requêtes sont journalisées.
    operationId: 'findAccountByPhone',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/lookup',
    grpc: `${ACCOUNT_ADMIN}/FindAccountByPhone`,
    access: { level: 'authenticated', anyRole: ACCOUNT_LOOKUP, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'account_lookup',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
