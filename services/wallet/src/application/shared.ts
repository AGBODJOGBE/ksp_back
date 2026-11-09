import { AppError, currentContext, hasRole, requireRecentMfa, requireUser } from '@ksp/platform';
import { HOLDER_TYPES, type Holder, type HolderType, MAX_AMOUNT } from '../domain/ledger';
import { type PageRequest } from './ports';

/** Erreurs du service (en-tête de wallet.proto). Messages en français. */
export const WalletErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('WALLET_VALIDATION_FAILED', message, { field }),
  transactionNotFound: () =>
    AppError.notFound('WALLET_TRANSACTION_NOT_FOUND', 'Cette opération du portefeuille est introuvable.'),
  payoutNotFound: () => AppError.notFound('WALLET_PAYOUT_NOT_FOUND', 'Ce reversement est introuvable.'),
  insufficientBalance: (balance: number) =>
    AppError.precondition(
      'WALLET_INSUFFICIENT_BALANCE',
      'Le solde disponible est insuffisant pour ce reversement.',
      { balance },
    ),
  notReversible: () =>
    AppError.precondition(
      'WALLET_TRANSACTION_NOT_REVERSIBLE',
      'Seul un encaissement peut être annulé par une écriture inverse.',
    ),
  keyReused: () =>
    AppError.conflict(
      'WALLET_IDEMPOTENCY_KEY_REUSED',
      'Cette référence a déjà servi pour une autre opération.',
    ),
  alreadyReversed: () =>
    AppError.conflict('WALLET_TRANSACTION_ALREADY_REVERSED', 'Cet encaissement a déjà été annulé.'),
  concurrentUpdate: () =>
    AppError.conflict('WALLET_CONCURRENT_UPDATE', 'Le portefeuille a été modifié en même temps. Réessayez.'),
  callerForbidden: () =>
    AppError.forbidden('WALLET_CALLER_FORBIDDEN', "Ce service n'est pas autorisé à appeler cette méthode."),
};

/** Back-office du portefeuille : la finance (rôles du domaine wallet). */
export const WALLET_STAFF = ['finance_officer', 'super_admin'] as const;
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

export function requireStaff(): { userId: string } {
  const user = requireUser();
  if (!WALLET_STAFF.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS);
  return { userId: user.userId };
}

/**
 * Service appelant authentifié par son jeton, s'il est autorisé. Sans vérificateur (développement
 * local sans jetons), l'appel est attribué au premier service autorisé ; en production, le jeton de
 * service est obligatoire.
 */
export function requireCaller(allowed: readonly string[]): string {
  const caller = currentContext()?.callerService;
  if (caller) {
    if (!allowed.includes(caller)) throw WalletErrors.callerForbidden();
    return caller;
  }
  const fallback = allowed[0];
  if (!fallback) throw WalletErrors.callerForbidden();
  return fallback;
}

/** Titulaire du connecté : son organisation active, sinon lui-même. */
export function currentHolder(): Holder {
  const user = requireUser();
  return user.activeContext && user.activeContext !== 'personal'
    ? { type: 'organization', id: user.activeContext }
    : { type: 'user', id: user.userId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Clé d'idempotence d'un reversement : 8 à 100 caractères, lettres, chiffres, « _ » et « - ». */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
/** Référence d'une écriture : 1 à 100 caractères, lettres, chiffres, « : », « _ » et « - ». */
export const REFERENCE = /^[A-Za-z0-9:_-]{1,100}$/;

export function requireUuid(field: string, value: string | undefined): string {
  if (!value || !UUID.test(value)) throw WalletErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

export function requireHolder(field: string, value: { type: string; id: string } | undefined): Holder {
  if (!value || !HOLDER_TYPES.includes(value.type as HolderType)) {
    throw WalletErrors.invalid(`${field}.type`, 'Titulaire attendu : user ou organization.');
  }
  return { type: value.type as HolderType, id: requireUuid(`${field}.id`, value.id) };
}

export function requireText(field: string, value: string | undefined, max: number): string {
  const text = (value ?? '').trim();
  if (!text) throw WalletErrors.invalid(field, 'Ce champ est obligatoire.');
  if (text.length > max) throw WalletErrors.invalid(field, `${max} caractères au plus.`);
  return text;
}

export function requireXof(field: string, money: { amount: number; currency: string } | undefined): number {
  const amount = Number(money?.amount ?? 0);
  if ((money?.currency || 'XOF') !== 'XOF') throw WalletErrors.invalid(field, 'Devise XOF attendue.');
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
    throw WalletErrors.invalid(field, `Montant entier en XOF attendu, de 1 à ${MAX_AMOUNT}.`);
  }
  return amount;
}

export function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw WalletErrors.invalid(field);
  return value as T;
}

export function parsePage(page: { limit?: number; cursor?: string } | undefined): PageRequest {
  const limit = page?.limit ? Math.min(100, Math.max(1, Math.trunc(page.limit))) : 20;
  const cursor = page?.cursor ? requireUuid('cursor', page.cursor) : null;
  return { limit, cursor };
}
