import { BACKOFFICE_MFA_SECONDS } from './cleaning-routes';
import { type RouteDefinition } from './route-manifest';

const PAYMENT = 'ksp.payment.v1.PaymentService';
const WEBHOOK = 'ksp.payment.v1.PaymentWebhookService';
const ADMIN = 'ksp.payment.v1.PaymentAdminService';
const LINKS = 'ksp.payment.v1.PaymentLinkPublicService';
const PAYOUT_ADMIN = 'ksp.payment.v1.PayoutAdminService';

/** Rôles du back-office des reversements (ADR-041) : la finance seulement. */
const PAYOUT_STAFF = ['finance_officer', 'super_admin'] as const;

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
  {
    // Écart de montant traité par la finance : lève le blocage des nouveaux paiements (ADR-032).
    operationId: 'resolvePaymentMismatch',
    method: 'POST',
    path: '/api/v1/admin/payment/payments/{id}/resolve-mismatch',
    grpc: `${ADMIN}/ResolveAmountMismatch`,
    access: { level: 'authenticated', anyRole: PAYMENT_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
    idempotencyKey: 'optional',
  },
  {
    // Page publique d'un lien de paiement (ADR-040) : payeur sans compte, jeton dans l'adresse.
    operationId: 'getPaymentLink',
    method: 'GET',
    path: '/api/v1/payment/links/{token}',
    grpc: `${LINKS}/GetPublicPaymentLink`,
    access: { level: 'public' },
    rateLimit: 'payment_link_read',
    requiresKnownClient: false,
  },
  {
    operationId: 'payPaymentLink',
    method: 'POST',
    path: '/api/v1/payment/links/{token}/pay',
    grpc: `${LINKS}/PayPaymentLink`,
    access: { level: 'public' },
    rateLimit: 'payment_link_pay',
    requiresKnownClient: false,
    idempotencyKey: 'required',
  },
  {
    // Développement seulement, comme simulatePayment.
    operationId: 'simulatePaymentLinkPayment',
    method: 'POST',
    path: '/api/v1/payment/links/{token}/simulate',
    grpc: `${LINKS}/SimulatePaymentLinkPayment`,
    access: { level: 'public' },
    rateLimit: 'payment_link_pay',
    requiresKnownClient: false,
  },
  {
    operationId: 'listPayouts',
    method: 'GET',
    path: '/api/v1/admin/payment/payouts',
    grpc: `${PAYOUT_ADMIN}/ListPayouts`,
    access: { level: 'authenticated', anyRole: PAYOUT_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    // Mode manuel : la finance a fait le virement (ADR-041).
    operationId: 'confirmPayout',
    method: 'POST',
    path: '/api/v1/admin/payment/payouts/{id}/confirm',
    grpc: `${PAYOUT_ADMIN}/ConfirmPayout`,
    access: { level: 'authenticated', anyRole: PAYOUT_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
    idempotencyKey: 'optional',
  },
  {
    operationId: 'failPayout',
    method: 'POST',
    path: '/api/v1/admin/payment/payouts/{id}/fail',
    grpc: `${PAYOUT_ADMIN}/FailPayout`,
    access: { level: 'authenticated', anyRole: PAYOUT_STAFF, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
    idempotencyKey: 'optional',
  },
] as const satisfies readonly RouteDefinition[];
