import { eventSubject } from '../shared/event-subject';
import {
  isCancellableByCustomer,
  isRecurringStop,
  type Mission,
  nextStart,
  stopSettlement,
} from '../../domain/mission';
import { isFreeCancellation } from '../../domain/schedule';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { type Changes, type OutboxMessage } from '../ports';
import { unrefundedWalletPayments } from '../../domain/payment';
import { type CaseAccess, currentCustomer, ownsCase } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { optionalText, type PageRequest, type PageResult } from '../shared/validation';

/**
 * Mission du client, sinon introuvable (404, sans révéler le dossier d'un autre). Mission
 * d'organisation : dans son contexte actif seulement ; agir exige org_admin ou org_member (ADR-049).
 */
async function ownMission(deps: CleaningDeps, missionId: string, access: CaseAccess): Promise<Mission> {
  const customer = currentCustomer();
  const mission = await deps.missions.findById(missionId);
  if (!mission || !ownsCase(customer, mission, access)) throw CleaningErrors.missionNotFound();
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

/**
 * Arrêt de la suite d'une mission récurrente par le client, après des passages faits (ADR-049) : la
 * mission ne coûte plus que ses passages faits ; ce qui a été payé au-delà, quel que soit le moyen,
 * est crédité dans son portefeuille prépayé — crédit enregistré ici et cleaning.mission.credited
 * publié dans la même transaction (wallet crédite une seule fois par identifiant). Payé moins que les
 * passages faits : rien à créditer, le reste dû demeure.
 */
export function creditOnStop(
  mission: Mission,
  creditId: string,
  now: Date,
): { mission: Mission; events: OutboxMessage[] } {
  const { dueTotal, credit } = stopSettlement(mission);
  const settled: Mission = {
    ...mission,
    payment: {
      ...mission.payment,
      total: dueTotal,
      credit: credit > 0 ? { id: creditId, amount: credit, creditedAt: now } : null,
    },
  };
  if (credit === 0) return { mission: settled, events: [] };
  return {
    mission: settled,
    events: [
      {
        type: 'cleaning.mission.credited',
        payload: {
          missionId: mission.id,
          customerId: mission.customerId,
          creditId,
          amount: { amount: credit, currency: 'XOF' },
          reason: 'recurring_cancelled',
          creditedAt: now.toISOString(),
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
    // Missions du contexte actif seulement (ADR-049) : personnelles, ou celles de l'organisation active.
    const result = await this.deps.missions.list(
      { customerId: customer.userId, organizationId: customer.organizationId },
      page,
    );
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
    return missionView(this.deps, await ownMission(this.deps, missionId, 'read'));
  }
}

/**
 * UC-CL-05 : annuler sa mission, sans frais jusqu'au délai limite ; au-delà, par le support. Une
 * mission récurrente dont des passages sont faits : arrêt de la suite, crédit au prorata (ADR-049).
 */
export class CancelMyMissionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { missionId: string; reason: string }): Promise<MissionView> {
    const mission = await ownMission(this.deps, input.missionId, 'act');
    const now = this.deps.clock.now();
    if (!isCancellableByCustomer(mission))
      throw CleaningErrors.invalidTransition(mission.status, 'cancelled');
    const settings = await this.deps.catalog.getSettings();
    if (!isFreeCancellation(nextStart(mission), now, settings.freeCancellationHours)) {
      throw CleaningErrors.cancellationTooLate(settings.freeCancellationHours);
    }
    const reason = optionalText('reason', input.reason, 500);
    const subject = await eventSubject(this.deps, mission);
    const stopped = cancelled(mission, reason, now);
    const { mission: refunded, events: refunds } = isRecurringStop(mission)
      ? creditOnStop(stopped, this.deps.ids.next(), now)
      : refundOnCancellation(stopped, now);
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
          // Arrêt d'une mission récurrente : montant initial, montant des passages faits, crédit.
          ...(refunded.payment.total !== mission.payment.total || refunded.payment.credit
            ? {
                details: {
                  previousTotal: mission.payment.total,
                  total: refunded.payment.total,
                  credited: refunded.payment.credit?.amount ?? 0,
                },
              }
            : {}),
        },
      ],
    });
  }
}
