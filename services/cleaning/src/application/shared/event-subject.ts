import { type Mission } from '../../domain/mission';
import { upfrontDue } from '../../domain/payment';
import { isBusinessContract } from '../../domain/standing';
import { type CleaningDeps } from '../deps';

/**
 * Champs facultatifs ajoutés aux événements d'une demande ou d'une mission (ADR-034) : code et nom
 * de la prestation, groupe de demandes. Le nom est celui en vigueur au moment de l'événement ;
 * absent si la prestation n'existe plus.
 */
export interface EventSubject {
  serviceCode: string;
  serviceName?: string;
  groupId?: string;
}

export async function eventSubject(
  deps: Pick<CleaningDeps, 'catalog'>,
  source: { serviceCode: string; groupId: string | null },
): Promise<EventSubject> {
  const service = await deps.catalog.findService(source.serviceCode);
  return {
    serviceCode: source.serviceCode,
    ...(service?.name ? { serviceName: service.name } : {}),
    ...(source.groupId ? { groupId: source.groupId } : {}),
  };
}

/**
 * Paiement « avant » encore dû, annoncé avec chaque passage planifié (cleaning.mission.scheduled,
 * ADR-049) pour prévenir le client : le passage ne démarrera pas sans lui. Absent sinon (paiement
 * « après », déjà réglé, ou mission d'entreprise réglée par facture).
 */
export function upfrontNotice(mission: Pick<Mission, 'organizationId' | 'payment'>): {
  amountDueBeforeStart?: { amount: number; currency: 'XOF' };
} {
  const due = isBusinessContract(mission) ? 0 : upfrontDue(mission.payment);
  return due > 0 ? { amountDueBeforeStart: { amount: due, currency: 'XOF' } } : {};
}
