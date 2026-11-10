import { type InterventionSchedule } from './intervention-schedule';
import { isWholeAmount, percentOf } from './money';
import { plannedInterventions, type Recurrence } from './recurrence';
import { type Slot } from './schedule';
import { type PriceLine } from './simulator';

/**
 * Devis (UC-CL-08) : lignes d'un passage, prix figé à l'envoi (un changement de grille ne le
 * modifie pas), 1 à 3 créneaux proposés, validité limitée (15 jours par défaut).
 */
export const MIN_PROPOSED_SLOTS = 1;
export const MAX_PROPOSED_SLOTS = 3;
const DAY_MS = 86_400_000;

export interface Quote {
  id: string;
  lines: PriceLine[];
  subtotal: number;
  interventionCount: number;
  total: number;
  proposedSlots: Slot[];
  validUntil: Date;
  depositPercent: number;
  depositAmount: number;
  recurrence: Recurrence | null;
  /** Plan de passages (ADR-052) ; absent ou null : ancienne récurrence, ou sans plan. */
  schedule?: InterventionSchedule | null;
  /** Dates exactes des passages tirées du plan (AAAA-MM-JJ), vides sans plan. */
  scheduledDates?: string[];
  teamSize: number;
  durationMinutes: number;
  sentAt: Date;
}

export interface QuoteDraft {
  id: string;
  lines: PriceLine[];
  proposedSlots: Slot[];
  validityDays: number;
  depositPercent: number;
  recurrence: Recurrence | null;
  /** Plan de passages (ADR-052) et ses dates : le nombre de passages est celui des dates. */
  schedule?: InterventionSchedule | null;
  scheduledDates?: string[];
  teamSize: number;
  durationMinutes: number;
  now: Date;
}

/**
 * Ligne cohérente : quantité et prix entiers, montant = quantité × prix unitaire. Un prix négatif
 * n'est admis que pour une ligne de remise (quantité 1) ; le total d'un passage reste positif.
 */
export function isValidLine(line: PriceLine): boolean {
  const price =
    isWholeAmount(line.unitPrice) || (Number.isSafeInteger(line.unitPrice) && line.quantity === 1);
  return (
    line.label.trim().length > 0 &&
    Number.isInteger(line.quantity) &&
    line.quantity >= 1 &&
    price &&
    line.amount === line.quantity * line.unitPrice
  );
}

export function linesSubtotal(lines: PriceLine[]): number {
  return lines.reduce((sum, line) => sum + line.amount, 0);
}

export function buildQuote(draft: QuoteDraft): Quote {
  const subtotal = linesSubtotal(draft.lines);
  const scheduledDates = draft.schedule ? (draft.scheduledDates ?? []) : [];
  // Plan de passages : nombre exact de dates ; ancienne récurrence : approximation (ADR-023).
  const interventionCount = scheduledDates.length || plannedInterventions(draft.recurrence);
  const total = subtotal * interventionCount;
  return {
    id: draft.id,
    lines: draft.lines,
    subtotal,
    interventionCount,
    total,
    proposedSlots: draft.proposedSlots,
    validUntil: new Date(draft.now.getTime() + draft.validityDays * DAY_MS),
    depositPercent: draft.depositPercent,
    depositAmount: percentOf(total, draft.depositPercent),
    recurrence: draft.recurrence,
    schedule: draft.schedule ?? null,
    scheduledDates,
    teamSize: draft.teamSize,
    durationMinutes: draft.durationMinutes,
    sentAt: draft.now,
  };
}

export function isQuoteExpired(quote: Pick<Quote, 'validUntil'>, now: Date): boolean {
  return quote.validUntil <= now;
}

/** Créneau proposé dont le début correspond, ou null. */
export function findProposedSlot(quote: Pick<Quote, 'proposedSlots'>, start: Date): Slot | null {
  return quote.proposedSlots.find((slot) => slot.start.getTime() === start.getTime()) ?? null;
}
