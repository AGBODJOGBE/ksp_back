import { BACKOFFICE_MFA_SECONDS } from './cleaning-routes';
import { type RouteDefinition } from './route-manifest';

const BILLING = 'ksp.billing.v1.BillingService';
const ADMIN = 'ksp.billing.v1.BillingAdminService';

/** Rôles du back-office de la facturation (CDC Nettoyage, partie 10). */
const BILLING_STAFF = ['finance_officer', 'cleaning_supervisor', 'cleaning_admin', 'super_admin'] as const;
const SETTINGS_ADMINS = ['cleaning_admin', 'finance_officer', 'super_admin'] as const;

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
    grpc: `${ADMIN}/RecordInvoicePayment`,
    access: { level: 'authenticated', anyRole: BILLING_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
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
