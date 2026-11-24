import { addDays, localDayStart, localPosition } from '../planning/time';
import { DomainRuleError } from './errors';
import { type TimeSlot } from './request-lifecycle';
import { assertOpenRequestLimit } from './request-status';
import { addHours } from './time';
import { newVisitFee, type VisitFee } from './visit-fee';

/**
 * Demande née d'un programme : renouvellement qui exige une nouvelle visite (R-PG-07) et nouvelle
 * commande (R-PG-08). Mêmes plafonds que l'envoi d'une demande (R-DM-04) et organisation non
 * suspendue. Sans visite (dernier constat de moins de 12 mois), la demande naît « visite faite » :
 * le devis est à composer, aucuns frais de visite. Avec visite, les frais de rang 1 sont créés au
 * montant du jour ; le créneau de la visite est convenu ensuite avec la supervision (ces appels ne
 * portent pas de créneaux).
 */
export function submitFollowUpRequest(input: {
  openCount: number;
  maxOpenRequests: number;
  organizationSuspended: boolean;
  withVisit: boolean;
  feeId: string;
  feeAmount: number;
  paymentHours: number;
  now: Date;
}): { status: 'visit_done' | 'awaiting_visit_fee'; fee: VisitFee | null } {
  if (input.organizationSuspended) throw new DomainRuleError('CLEANING_ORGANIZATION_SUSPENDED');
  assertOpenRequestLimit(input.openCount, input.maxOpenRequests);
  if (!input.withVisit) return { status: 'visit_done', fee: null };
  return {
    status: 'awaiting_visit_fee',
    fee: newVisitFee({
      id: input.feeId,
      rank: 1,
      amount: input.feeAmount,
      now: input.now,
      paymentHours: input.paymentHours,
    }),
  };
}

/**
 * Créneau de visite par défaut d'une demande née d'un programme : le renouvellement et la nouvelle
 * commande ne portent pas de créneaux, alors qu'une demande en garde toujours au moins un.
 * Interprétation : le premier matin (8 h à 12 h, Porto-Novo) après le délai minimum avant une visite,
 * à confirmer avec le client par la supervision.
 */
export function defaultVisitSlot(now: Date, minLeadHours: number): TimeSlot {
  const day = addDays(localPosition(addHours(now, minLeadHours)).day, 1);
  const start = addHours(localDayStart(day), 8);
  return { start, end: addHours(start, 4) };
}
