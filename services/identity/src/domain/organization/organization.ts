/**
 * Organisation cliente (compte entreprise, UC-ID-12 à 16, ADR-027). Créée par un client depuis le
 * portail, elle attend la validation d'un admin KSP ; seule une organisation validée peut devenir
 * le contexte actif d'une session (claim ctx du jeton d'accès).
 */
export type OrganizationStatus = 'pending_review' | 'active' | 'rejected' | 'suspended';

/** Rôle d'un membre dans son organisation (portée org). Le créateur en est l'administrateur. */
export type OrgRole = 'org_admin' | 'org_member' | 'org_viewer';

export interface Organization {
  id: string;
  /** Raison sociale. */
  legalName: string;
  address: string;
  /** Identifiant fiscal unique (Bénin), 13 chiffres. */
  ifu: string;
  /** Registre du commerce et du crédit mobilier, facultatif. */
  rccm: string | null;
  /** E-mail de facturation, enregistré seulement après sa confirmation par code (ADR-026). */
  billingEmail: string | null;
  status: OrganizationStatus;
  createdBy: string;
  createdAt: Date;
  /** Admin KSP qui a validé ou refusé la demande. */
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  /** Suspension en cours. */
  suspendedAt: Date | null;
  suspensionReason: string | null;
}

/** Décisions du back-office sur une organisation. */
export type OrganizationDecision = 'validate' | 'reject' | 'suspend' | 'reactivate';

const TRANSITIONS: Readonly<
  Record<OrganizationDecision, { from: OrganizationStatus; to: OrganizationStatus }>
> = {
  validate: { from: 'pending_review', to: 'active' },
  reject: { from: 'pending_review', to: 'rejected' },
  suspend: { from: 'active', to: 'suspended' },
  reactivate: { from: 'suspended', to: 'active' },
};

/** État atteint par une décision, ou null si elle n'est pas possible depuis l'état actuel. */
export function decide(
  status: OrganizationStatus,
  decision: OrganizationDecision,
): OrganizationStatus | null {
  const transition = TRANSITIONS[decision];
  return transition.from === status ? transition.to : null;
}

/** État de départ attendu par une décision (mise à jour conditionnelle en base). */
export function requiredStatus(decision: OrganizationDecision): OrganizationStatus {
  return TRANSITIONS[decision].from;
}

/** Les décisions qui exigent un motif communiqué au client. */
export function needsReason(decision: OrganizationDecision): boolean {
  return decision === 'reject' || decision === 'suspend';
}

/** Seule une organisation validée peut devenir le contexte actif d'une session. */
export function canBeActiveContext(status: OrganizationStatus): boolean {
  return status === 'active';
}

/** L'e-mail de facturation se déclare tant que la demande est en attente ou l'organisation validée. */
export function acceptsBillingEmail(status: OrganizationStatus): boolean {
  return status === 'pending_review' || status === 'active';
}

/** Demandes en attente qu'un même compte peut avoir en même temps (protection contre les abus). */
export const MAX_PENDING_REQUESTS = 3;

export const LEGAL_NAME_MAX_LENGTH = 200;
export const ADDRESS_MAX_LENGTH = 300;
export const REASON_MAX_LENGTH = 500;

/** Texte libre d'une ligne : ni caractère de contrôle ni retour à la ligne. */
const CONTROL = /[\p{Cc}\p{Cf}]/u;
/** Au moins une lettre ou un chiffre. */
const MEANINGFUL = /[\p{L}\p{N}]/u;
const IFU = /^[0-9]{13}$/;
/** Forme volontairement souple (« RB/COT/19 B 12345 ») : lettres, chiffres, espaces, / . - */
const RCCM = /^[A-Z0-9][A-Z0-9 /.-]{3,49}$/;

function singleLine(value: string, maxLength: number): string | null {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length === 0 || text.length > maxLength || CONTROL.test(text) || !MEANINGFUL.test(text)) {
    return null;
  }
  return text;
}

/** Raison sociale nettoyée (espaces en trop retirés), ou null si elle n'est pas acceptable. */
export function normalizeLegalName(value: string): string | null {
  const name = singleLine(value, LEGAL_NAME_MAX_LENGTH);
  return name && name.length >= 2 ? name : null;
}

export function normalizeAddress(value: string): string | null {
  const address = singleLine(value, ADDRESS_MAX_LENGTH);
  return address && address.length >= 5 ? address : null;
}

/**
 * IFU du Bénin : 13 chiffres, espaces ignorés. Seul le format est contrôlé : la clé de contrôle
 * éventuelle n'est pas vérifiée (règle non documentée), l'admin KSP contrôle l'IFU à la validation.
 */
export function normalizeIfu(value: string): string | null {
  const ifu = value.replace(/\s+/g, '');
  return IFU.test(ifu) ? ifu : null;
}

/** RCCM en majuscules, espaces en trop retirés ; null si la forme n'est pas plausible. */
export function normalizeRccm(value: string): string | null {
  const rccm = value.trim().replace(/\s+/g, ' ').toUpperCase();
  return RCCM.test(rccm) ? rccm : null;
}

/** Motif d'un refus ou d'une suspension, communiqué au client. */
export function normalizeReason(value: string): string | null {
  return singleLine(value, REASON_MAX_LENGTH);
}
