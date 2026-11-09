import { eventSubject } from '../shared/event-subject';
import { isCancellableByCustomer, type Mission, nextStart } from '../../domain/mission';
import { isFreeCancellation } from '../../domain/schedule';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { type Changes, type OutboxMessage } from '../ports';
import { unrefundedWalletPayments } from '../../domain/payment';
import { currentCustomer } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { optionalText, type PageRequest, type PageResult } from '../shared/validation';

/** Mission du client, sinon introuvable (404, sans révéler le dossier d'un autre). */
async function ownMission(deps: CleaningDeps, missionId: string): Promise<Mission> {
  const customer = currentCustomer();
  const mission = await deps.missions.findById(missionId);
  if (!mission || mission.customerId !== customer.userId) throw CleaningErrors.missionNotFound();
  return mission;
}

/** Enregistre une mission modifiée (contrôle de version) et renvoie sa vue. */
export async function saveMission(
  deps: CleaningDeps,
  mission: Mission,
  changes: Changes,
): Promise<MissionView> {
  const next = { ...mission, updatedAt: deps.clock.now() };
  if (!(await deps.missions.save(next, changes))) throw CleaningErrors.concurrentUpdate();
  return missionView(deps, { ...next, version: next.version + 1 });
}

/** Annule la mission et ses passages non commencés (et lève une éventuelle suspension). */
export function cancelled(mission: Mission, reason: string | null, now: Date): Mission {
  return {
    ...mission,
    status: 'cancelled',
    cancellationReason: reason,
    suspension: null,
    interventions: mission.interventions.map((intervention) =>
      intervention.status === 'planned' || intervention.status === 'on_hold'
        ? { ...intervention, status: 'cancelled', cancellationCause: 'manual', cancelledAt: now }
        : intervention,
    ),
  };
}

/**
 * À l'annulation (ADR-046) : si aucun passage n'a commencé, les paiements par portefeuille de la
 * mission sont remboursés dans le portefeuille du client — marqués remboursés ici, et
 * cleaning.mission.refunded publié dans la même transaction (wallet rembourse chaque débit, une seule
 * fois). Un passage commencé ou fait : aucun remboursement automatique (la finance peut créditer le
 * portefeuille au back-office). Les paiements en espèces ou Mobile Money ne sont pas concernés.
 */
export function refundOnCancellation(
  mission: Mission,
  now: Date,
): { mission: Mission; events: OutboxMessage[] } {
  const started = mission.interventions.some((i) => i.startedAt !== null || i.completedAt !== null);
  const refunds = started ? [] : unrefundedWalletPayments(mission.payment);
  if (refunds.length === 0) return { mission, events: [] };
  const ids = new Set(refunds.map((payment) => payment.id));
  return {
    mission: {
      ...mission,
      payment: {
        ...mission.payment,
        payments: mission.payment.payments.map((payment) =>
          ids.has(payment.id) ? { ...payment, refundedAt: now } : payment,
        ),
      },
    },
    events: [
      {
        type: 'cleaning.mission.refunded',
        payload: {
          missionId: mission.id,
          customerId: mission.customerId,
          refunds: refunds.map((payment) => ({
            paymentRecordId: payment.id,
            walletTransactionId: payment.reference!,
            amount: { amount: payment.amount, currency: 'XOF' },
          })),
          reason: 'mission_cancelled',
          refundedAt: now.toISOString(),
        },
      },
    ],
  };
}

/** UC-CL-03 : mes missions. */
export class ListMyMissionsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(page: PageRequest): Promise<PageResult<MissionView>> {
    const customer = currentCustomer();
    const result = await this.deps.missions.list({ customerId: customer.userId }, page);
    return {
      items: await Promise.all(result.items.map((mission) => missionView(this.deps, mission))),
      nextCursor: result.nextCursor,
    };
  }
}

/** UC-CL-03 : détail d'une de mes missions, avec l'équipe de chaque passage. */
export class GetMyMissionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(missionId: string): Promise<MissionView> {
    return missionView(this.deps, await ownMission(this.deps, missionId));
  }
}

/** UC-CL-05 : annuler sa mission, sans frais jusqu'au délai limite ; au-delà, par le support. */
export class CancelMyMissionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { missionId: string; reason: string }): Promise<MissionView> {
    const mission = await ownMission(this.deps, input.missionId);
    const now = this.deps.clock.now();
    if (!isCancellableByCustomer(mission))
      throw CleaningErrors.invalidTransition(mission.status, 'cancelled');
    const settings = await this.deps.catalog.getSettings();
    if (!isFreeCancellation(nextStart(mission), now, settings.freeCancellationHours)) {
      throw CleaningErrors.cancellationTooLate(settings.freeCancellationHours);
    }
    const reason = optionalText('reason', input.reason, 500);
    const subject = await eventSubject(this.deps, mission);
    const { mission: refunded, events: refunds } = refundOnCancellation(cancelled(mission, reason, now), now);
    return saveMission(this.deps, refunded, {
      events: [
        ...refunds,
        {
          type: 'cleaning.request.cancelled',
          payload: {
            ...subject,
            requestId: mission.requestId,
            missionId: mission.id,
            customerId: mission.customerId,
            organizationId: mission.organizationId,
            cancelledBy: 'customer',
            outcome: 'cancelled',
          },
        },
      ],
      audit: [
        {
          actorId: mission.customerId,
          action: 'mission.cancelled',
          entityType: 'mission',
          entityId: mission.id,
          at: now,
        },
      ],
    });
  }
}
