import { BACKOFFICE_MFA_SECONDS, CRITICAL_MFA_SECONDS } from '../access/mfa-age';
import { type RouteDefinition } from './route-manifest';

const ACCOUNT = 'ksp.wallet.v1.WalletAccountService';
const ADMIN = 'ksp.wallet.v1.WalletAdminService';

/** Rôles du back-office du portefeuille (ADR-042) : la finance seulement. */
const WALLET_STAFF = ['finance_officer', 'super_admin'] as const;
const staff = {
  level: 'authenticated',
  anyRole: WALLET_STAFF,
  recentMfaSeconds: BACKOFFICE_MFA_SECONDS,
} as const;

/**
 * Routes du portefeuille (ADR-042) : espace du titulaire connecté (son compte, ou son organisation
 * active) et back-office de la finance. Portefeuille prépayé (ADR-046) : recharge par Mobile Money
 * et crédit manuel de la finance ; les débits viennent des services métier (Nettoyage, factures).
 */
export const WALLET_ROUTES = [
  {
    operationId: 'getMyWallet',
    method: 'GET',
    path: '/api/v1/wallet/me',
    grpc: `${ACCOUNT}/GetMyWallet`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listMyWalletStatement',
    method: 'GET',
    path: '/api/v1/wallet/me/statement',
    grpc: `${ACCOUNT}/ListMyStatement`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'createWalletTopUp',
    method: 'POST',
    path: '/api/v1/wallet/me/top-ups',
    grpc: `${ACCOUNT}/CreateTopUp`,
    access: { level: 'authenticated' },
    rateLimit: 'payment_create',
    requiresKnownClient: false,
    idempotencyKey: 'required',
  },
  {
    operationId: 'listMyWalletPayouts',
    method: 'GET',
    path: '/api/v1/wallet/me/payouts',
    grpc: `${ACCOUNT}/ListMyPayouts`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getHolderWallet',
    method: 'GET',
    path: '/api/v1/admin/wallet/holders/{type}/{id}',
    grpc: `${ADMIN}/GetHolderWallet`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listHolderWalletStatement',
    method: 'GET',
    path: '/api/v1/admin/wallet/holders/{type}/{id}/statement',
    grpc: `${ADMIN}/ListHolderStatement`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'creditPrepaidWallet',
    method: 'POST',
    path: '/api/v1/admin/wallet/holders/{type}/{id}/credits',
    grpc: `${ADMIN}/CreditPrepaidWallet`,
    // Argent : double authentification de moins de 10 minutes (ADR-050).
    access: { ...staff, recentMfaSeconds: CRITICAL_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
    idempotencyKey: 'required',
  },
  {
    // Demandes de crédit au-delà du seuil de double validation (ADR-048).
    operationId: 'listManualCreditRequests',
    method: 'GET',
    path: '/api/v1/admin/wallet/credit-requests',
    grpc: `${ADMIN}/ListManualCreditRequests`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    // Validation par un second membre de la finance : l'argent est crédité (ADR-048).
    operationId: 'approveManualCredit',
    method: 'POST',
    path: '/api/v1/admin/wallet/credit-requests/{id}/approve',
    grpc: `${ADMIN}/ApproveManualCredit`,
    access: { ...staff, recentMfaSeconds: CRITICAL_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listWalletPayouts',
    method: 'GET',
    path: '/api/v1/admin/wallet/payouts',
    grpc: `${ADMIN}/ListWalletPayouts`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getWalletLedgerOverview',
    method: 'GET',
    path: '/api/v1/admin/wallet/overview',
    grpc: `${ADMIN}/GetLedgerOverview`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  // Retraits vers Mobile Money (R-WL-04, ADR-055 décision 8) : demande du titulaire, traitement
  // puis validation par une deuxième personne de la finance.
  {
    operationId: 'requestWithdrawal',
    method: 'POST',
    path: '/api/v1/wallet/me/withdrawals',
    grpc: `${ACCOUNT}/RequestWithdrawal`,
    access: { level: 'authenticated' },
    rateLimit: 'payment_create',
    requiresKnownClient: false,
    idempotencyKey: 'required',
    successStatus: 201,
  },
  {
    operationId: 'listMyWithdrawals',
    method: 'GET',
    path: '/api/v1/wallet/me/withdrawals',
    grpc: `${ACCOUNT}/ListMyWithdrawals`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    // Refus d'une demande de crédit par un membre de la finance (v2).
    operationId: 'rejectManualCredit',
    method: 'POST',
    path: '/api/v1/admin/wallet/credit-requests/{id}/reject',
    grpc: `${ADMIN}/RejectManualCredit`,
    access: { ...staff, recentMfaSeconds: CRITICAL_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listWithdrawals',
    method: 'GET',
    path: '/api/v1/admin/wallet/withdrawals',
    grpc: `${ADMIN}/ListWithdrawals`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'processWithdrawal',
    method: 'POST',
    path: '/api/v1/admin/wallet/withdrawals/{id}/process',
    grpc: `${ADMIN}/ProcessWithdrawal`,
    access: { ...staff, recentMfaSeconds: CRITICAL_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'approveWithdrawal',
    method: 'POST',
    path: '/api/v1/admin/wallet/withdrawals/{id}/approve',
    grpc: `${ADMIN}/ApproveWithdrawal`,
    access: { ...staff, recentMfaSeconds: CRITICAL_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'rejectWithdrawal',
    method: 'POST',
    path: '/api/v1/admin/wallet/withdrawals/{id}/reject',
    grpc: `${ADMIN}/RejectWithdrawal`,
    access: { ...staff, recentMfaSeconds: CRITICAL_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
