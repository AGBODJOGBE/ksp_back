import { BACKOFFICE_MFA_SECONDS } from './cleaning-routes';
import { type RouteDefinition } from './route-manifest';

const PAYMENT = 'ksp.payment.v1.PaymentService';
const WEBHOOK = 'ksp.payment.v1.PaymentWebhookService';
const ADMIN = 'ksp.payment.v1.PaymentAdminService';

/** Rôles du back-office des paiements en ligne (ADR-031). */
const PAYMENT_STAFF = ['finance_officer', 'cleaning_admin', 'super_admin'] as const;

/** Préfixe des notifications des prestataires : corps brut, transmis octet pour octet (ADR-031). */
export const PAYMENT_WEBHOOK_PREFIX = '/api/v1/payment/webhooks/';

/**
 * Routes du paiement en ligne par Mobile Money (ADR-031) : espace client, notification signée du
 * prestataire (publique), simulation en développement, back-office. Reprises des extensions
 * x-ksp-* du contrat OpenAPI ; le test de conformité vérifie qu'elles restent identiques.
 */
export const PAYMENT_ROUTES = [
  {
    operationId: 'createPayment',
    method: 'POST',
    path: '/api/v1/payment/payments',
    grpc: `${PAYMENT}/CreatePayment`,
    access: { level: 'authenticated' },
    rateLimit: 'payment_create',
    requiresKnownClient: false,
    idempotencyKey: 'required',
  },
  {
    operationId: 'listMyPayments',
    method: 'GET',
    path: '/api/v1/payment/payments',
    grpc: `${PAYMENT}/ListMyPayments`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getMyPayment',
    method: 'GET',
    path: '/api/v1/payment/payments/{id}',
    grpc: `${PAYMENT}/GetMyPayment`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'simulatePayment',
    method: 'POST',
    path: '/api/v1/payment/payments/{id}/simulate',
    grpc: `${PAYMENT}/SimulatePayment`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    // Publique : la confiance vient de la signature, vérifiée par payment sur le corps exact.
    operationId: 'receiveFedapayWebhook',
    method: 'POST',
    path: '/api/v1/payment/webhooks/fedapay',
    grpc: `${WEBHOOK}/ReceiveProviderNotification`,
    access: { level: 'public' },
    rateLimit: 'payment_webhook',
    requiresKnownClient: false,
  },
  {
    operationId: 'listPayments',
    method: 'GET',
    path: '/api/v1/admin/payment/payments',
    grpc: `${ADMIN}/ListPayments`,
    access: { level: 'authenticated', anyRole: PAYMENT_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
