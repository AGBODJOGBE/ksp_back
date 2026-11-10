import { BACKOFFICE_MFA_SECONDS, CRITICAL_MFA_SECONDS } from './cleaning-routes';
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
] as const satisfies readonly RouteDefinition[];
