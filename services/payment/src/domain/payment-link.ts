import { isUnderReview, type PaymentIntent, SUBJECT_TYPES } from './payment-intent';

/**
 * Lien de paiement (ADR-038) : un service émetteur (recovery) demande à faire payer un objet à lui
 * (une échéance d'un dossier de recouvrement…) par une personne qui n'a pas de compte KSP. Le lien
 * porte un montant fixe en XOF, le bénéficiaire affiché, une date d'expiration ; son adresse
 * publique contient un jeton long et imprévisible, dont seule l'empreinte est enregistrée.
 *
 * Chaque essai de paiement est une intention de paiement ordinaire (`PaymentIntent` sans payeur
 * connecté, rattachée au lien) : mêmes confirmations par le prestataire, mêmes écarts de montant.
 * Le statut du lien découle de ses essais et de son état propre (révocation, expiration) :
 * `paid` > `under_review` > `revoked` > `expired` > `active`. Une réussite l'emporte sur tout : un
 * paiement tardif sur un lien révoqué ou expiré est de l'argent reçu (il est enregistré).
 */
export interface PaymentLink {
  id: string;
  /** Service émetteur (jeton de service), seul à pouvoir le lire ou le révoquer. */
  issuer: string;
  /** Clé d'idempotence de la création, propre à l'émetteur. */
  idempotencyKey: string;
  /** Type d'objet de l'émetteur, par exemple `recovery_installment`. */
  subjectType: string;
  subjectId: string;
  /** Référence lisible de l'émetteur, affichée au payeur et transmise au prestataire. */
  reference: string;
  /** Bénéficiaire affiché au payeur (créancier). */
  beneficiaryName: string;
  /** Libellé affiché au payeur (« Échéance 2 sur 6 »). */
  description: string;
  /** Entier en FCFA, strictement positif. */
  amount: number;
  /** Échéance affichée (AAAA-MM-JJ), null si aucune. */
  dueDate: string | null;
  /** Payeur, facultatifs : jamais journalisés, jamais montrés sur la page publique. */
  payerName: string | null;
  payerPhone: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export type LinkStatus = 'active' | 'paid' | 'under_review' | 'revoked' | 'expired';
export const LINK_STATUSES: readonly LinkStatus[] = ['active', 'paid', 'under_review', 'revoked', 'expired'];

/** Type d'objet d'un lien : minuscules, chiffres et « _ », 3 à 50 caractères. */
export const LINK_SUBJECT_TYPE = /^[a-z][a-z0-9_]{2,49}$/;
/** Montant d'un lien ou d'un reversement : entier en XOF, 1 000 000 000 au plus. */
export const MAX_AMOUNT = 1_000_000_000;
/** Durée de validité d'un lien : entre 1 heure et 180 jours. */
export const LINK_MIN_LIFETIME_MS = 3_600_000;
export const LINK_MAX_LIFETIME_MS = 180 * 24 * 3_600_000;
/** Jeton d'un lien : 43 caractères base64url (256 bits). */
export const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Les types d'objet des paiements par compte sont réservés : leur montant vient de cleaning ou billing. */
export function isLinkSubjectType(value: string): boolean {
  return LINK_SUBJECT_TYPE.test(value) && !(SUBJECT_TYPES as readonly string[]).includes(value);
}

type Attempt = Pick<PaymentIntent, 'id' | 'status' | 'mismatchResolution' | 'completedAt' | 'updatedAt'>;

/** Statut du lien, d'après ses essais de paiement et son état propre. */
export function linkStatus(
  link: Pick<PaymentLink, 'revokedAt' | 'expiresAt'>,
  attempts: readonly Attempt[],
  now: Date,
): LinkStatus {
  if (attempts.some((attempt) => attempt.status === 'succeeded')) return 'paid';
  if (attempts.some(isUnderReview)) return 'under_review';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt <= now) return 'expired';
  return 'active';
}

/** Essai réussi (le premier), null sinon. */
export function paidAttempt<T extends Attempt>(attempts: readonly T[]): T | null {
  return [...attempts].sort((a, b) => a.id.localeCompare(b.id)).find((a) => a.status === 'succeeded') ?? null;
}

/** Dernier essai (identifiants UUID v7 : triés par date de création), null s'il n'y en a aucun. */
export function lastAttempt<T extends Pick<PaymentIntent, 'id'>>(attempts: readonly T[]): T | null {
  return attempts.reduce<T | null>((last, attempt) => (!last || attempt.id > last.id ? attempt : last), null);
}

/** Rejeu d'une création : même objet et même montant, sinon la clé a servi à autre chose. */
export function sameLinkRequest(
  link: Pick<PaymentLink, 'subjectType' | 'subjectId' | 'amount'>,
  request: Pick<PaymentLink, 'subjectType' | 'subjectId' | 'amount'>,
): boolean {
  return (
    link.subjectType === request.subjectType &&
    link.subjectId === request.subjectId &&
    link.amount === request.amount
  );
}

/** Issue d'une révocation demandée par l'émetteur. */
export type RevocationOutcome =
  | { kind: 'revoked'; link: PaymentLink }
  /** Déjà révoqué : rien ne change (rejouable). */
  | { kind: 'replay' }
  /** Déjà payé : l'argent est reçu, la révocation n'a plus de sens. */
  | { kind: 'refused' };

export function revoke(
  link: PaymentLink,
  status: LinkStatus,
  input: { reason: string | null; now: Date },
): RevocationOutcome {
  if (status === 'paid') return { kind: 'refused' };
  if (link.revokedAt) return { kind: 'replay' };
  return {
    kind: 'revoked',
    link: { ...link, revokedAt: input.now, revokedReason: input.reason, updatedAt: input.now },
  };
}

/** Raison d'un refus de paiement d'un lien. */
export type PayRefusal = 'paid' | 'under_review' | 'revoked' | 'expired';

/** Un lien n'accepte un nouvel essai que s'il est `active`. */
export function payRefusal(status: LinkStatus): PayRefusal | null {
  return status === 'active' ? null : status;
}

/** Échéance au format AAAA-MM-JJ (date de calendrier valide). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
