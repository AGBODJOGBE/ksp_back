import {
  addBusinessDays,
  addDaysToInstant,
  addMonths,
  daysBetween,
  localDay,
  localInstant,
  type LocalDay,
} from './calendar';
import { type CaseStage } from './case';
import { type RecoverySettings } from './settings';

/**
 * Délais du Recouvrement (parties 4, 5 et 17.1) et prescription (partie 2). Les jours fériés viennent
 * d'une table réglable, fournie par l'appelant.
 */

/** Fin de l'examen de recevabilité : N jours ouvrés après la réception (2), à la fin de la journée. */
export function reviewDeadline(
  receivedAt: Date,
  settings: RecoverySettings,
  holidays: ReadonlySet<LocalDay>,
): Date {
  return localInstant(addBusinessDays(localDay(receivedAt), settings.reviewBusinessDays, holidays), 23, 59);
}

/** Dernier jour pour reverser un encaissement confirmé au créancier (R-CO-03). */
export function remittanceDeadline(
  collectedAt: Date,
  settings: RecoverySettings,
  holidays: ReadonlySet<LocalDay>,
): LocalDay {
  return addBusinessDays(localDay(collectedAt), settings.remittanceBusinessDays, holidays);
}

/** Dernier jour pour qu'un partenaire vire à KSP ce qu'il a encaissé (R-HU-05 : 5 jours ouvrés, `FIXED_RULES`). */
export function partnerTransferDeadline(
  declaredAt: Date,
  businessDays: number,
  holidays: ReadonlySet<LocalDay>,
): LocalDay {
  return addBusinessDays(localDay(declaredAt), businessDays, holidays);
}

export const feePaymentDeadline = (createdAt: Date, s: RecoverySettings): Date =>
  addDaysToInstant(createdAt, s.feePaymentDays);
export const infoCompletionDeadline = (requestedAt: Date, s: RecoverySettings): Date =>
  addDaysToInstant(requestedAt, s.infoCompletionDays);
export const creditorApprovalDeadline = (proposedAt: Date, s: RecoverySettings): Date =>
  addDaysToInstant(proposedAt, s.creditorApprovalDays);
export const disputeAnswerDeadline = (openedAt: Date, s: RecoverySettings): Date =>
  addDaysToInstant(openedAt, s.disputeAnswerDays);

/**
 * Fin du délai de l'étape (partie 5) : notification du mandat 8 jours, relance amiable 21 jours, mise en
 * demeure 15 jours après sa réception. L'échéancier suit ses échéances ; huissier et procédure suivent
 * le partenaire et la juridiction : pas de délai fixe.
 */
export function stageDeadline(stage: CaseStage, startedAt: Date, settings: RecoverySettings): Date | null {
  switch (stage) {
    case 'notice':
      return addDaysToInstant(startedAt, settings.noticeResponseDays);
    case 'amicable':
      return addDaysToInstant(startedAt, settings.amicableDurationDays);
    case 'formal_notice':
      return addDaysToInstant(startedAt, settings.formalNoticeDays);
    default:
      return null;
  }
}

/**
 * Date de prescription : date d'exigibilité, ou dernier acte qui l'interrompt (reconnaissance de dette,
 * échéancier signé), plus la durée de la nature de la créance. Durées et effet interruptif à confirmer
 * par l'avocat (partie 2) : ils sont fournis par l'appelant.
 */
export function prescriptionDate(
  dueDay: LocalDay,
  periodMonths: number,
  interruptedOn: LocalDay | null = null,
): LocalDay {
  const start = interruptedOn !== null && interruptedOn > dueDay ? interruptedOn : dueDay;
  return addMonths(start, periodMonths);
}

export type PrescriptionState = 'running' | 'alert' | 'prescribed';

/** Alerte N jours avant la prescription (90) ; au jour dit, la créance est prescrite. */
export function prescriptionState(
  prescribedOn: LocalDay,
  today: LocalDay,
  alertDays: number,
): PrescriptionState {
  const remaining = daysBetween(today, prescribedOn);
  if (remaining <= 0) return 'prescribed';
  return remaining <= alertDays ? 'alert' : 'running';
}
