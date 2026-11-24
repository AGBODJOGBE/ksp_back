import { BACKOFFICE_MFA_SECONDS } from '../access/mfa-age';
import { type RouteDefinition } from './route-manifest';

const BILLING = 'ksp.billing.v1.BillingService';
const ADMIN = 'ksp.billing.v1.BillingAdminService';

/** Rôles du back-office de la facturation (CDC Nettoyage, partie 10). */
const BILLING_STAFF = ['finance_officer', 'cleaning_supervisor', 'cleaning_admin', 'super_admin'] as const;
const SETTINGS_ADMINS = ['cleaning_admin', 'finance_officer', 'super_admin'] as const;
/** Écritures d'argent au back-office : la finance seule (CDC Nettoyage v2, R-PE-04). */
const FINANCE = ['finance_officer', 'super_admin'] as const;

/**
 * Routes de la facturation : « Mes factures » et back-office. Reprises des extensions x-ksp-* du
 * contrat OpenAPI ; le test de conformité vérifie qu'elles restent identiques.
 */
export const BILLING_ROUTES = [
  {
    operationId: 'listMyInvoices',
    method: 'GET',
    path: '/api/v1/billing/invoices',
    grpc: `${BILLING}/ListMyInvoices`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getMyInvoice',
    method: 'GET',
    path: '/api/v1/billing/invoices/{id}',
    grpc: `${BILLING}/GetMyInvoice`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    // Reste dû payé depuis le portefeuille prépayé (ADR-046).
    operationId: 'payMyInvoiceFromWallet',
    method: 'POST',
    path: '/api/v1/billing/invoices/{id}/pay',
    grpc: `${BILLING}/PayMyInvoiceFromWallet`,
    access: { level: 'authenticated' },
    rateLimit: 'payment_create',
    requiresKnownClient: false,
    idempotencyKey: 'required',
  },
  {
    operationId: 'listInvoices',
    method: 'GET',
    path: '/api/v1/admin/billing/invoices',
    grpc: `${ADMIN}/ListInvoices`,
    access: { level: 'authenticated', anyRole: BILLING_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getInvoice',
    method: 'GET',
    path: '/api/v1/admin/billing/invoices/{id}',
    grpc: `${ADMIN}/GetInvoice`,
    access: { level: 'authenticated', anyRole: BILLING_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'recordInvoicePayment',
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/payments',
    // Retiré en v2 (R-PE-04) : refuse toute facture v2 ; le virement passe par le portefeuille.
    grpc: `${ADMIN}/RecordInvoicePayment`,
    access: { level: 'authenticated', anyRole: FINANCE, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
    // Ajouté après le branchement du back-office : facultatif, pour ne rien casser.
    idempotencyKey: 'optional',
  },
  {
    operationId: 'getBillingSettings',
    method: 'GET',
    path: '/api/v1/admin/billing/settings',
    grpc: `${ADMIN}/GetBillingSettings`,
    access: { level: 'authenticated', anyRole: SETTINGS_ADMINS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'updateBillingSettings',
    method: 'PUT',
    path: '/api/v1/admin/billing/settings',
    grpc: `${ADMIN}/UpdateBillingSettings`,
    access: { level: 'authenticated', anyRole: SETTINGS_ADMINS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
