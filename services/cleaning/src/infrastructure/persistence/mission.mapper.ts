import {
  type Intervention as InterventionRow,
  type Mission as MissionRow,
  type MissionPayment as PaymentRow,
} from '../../../prisma/generated';
import {
  type ChecklistItem,
  type Intervention,
  type InterventionCancellationCause,
  type InterventionStatus,
  type Mission,
  type MissionStatus,
  type SuspensionCause,
} from '../../domain/mission';
import { type PaymentMethod, type PaymentPlan } from '../../domain/payment';
import { slotFrom } from '../../domain/schedule';
import { json } from './changes';
import { recurrenceFromJson, recurrenceToJson } from './quote-request.mapper';

export const MISSION_INCLUDE = {
  interventions: { orderBy: { scheduledStart: 'asc' as const } },
  payments: { orderBy: { recordedAt: 'asc' as const } },
};
export type MissionWithRelations = MissionRow & { interventions: InterventionRow[]; payments: PaymentRow[] };

function toIntervention(row: InterventionRow): Intervention {
  return {
    id: row.id,
    status: row.status as InterventionStatus,
    scheduledStart: row.scheduledStart,
    durationMinutes: row.durationMinutes,
    agentIds: row.agentIds,
    checklist: row.checklist as unknown as ChecklistItem[],
    incidentNote: row.incidentNote,
    beforePhotoFileIds: row.beforePhotoFileIds,
    afterPhotoFileIds: row.afterPhotoFileIds,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    cancellationCause: row.cancellationCause as InterventionCancellationCause | null,
    cancelledAt: row.cancelledAt,
  };
}

export function toMission(row: MissionWithRelations): Mission {
  return {
    id: row.id,
    requestId: row.requestId,
    quoteId: row.quoteId,
    customerId: row.customerId,
    organizationId: row.organizationId,
    status: row.status as MissionStatus,
    serviceCode: row.serviceCode,
    commune: row.commune,
    address: row.address,
    chosenSlot: { start: row.chosenSlotStart, end: row.chosenSlotEnd },
    recurrence: recurrenceFromJson(row.recurrence),
    plannedInterventions: row.plannedInterventions,
    interventions: row.interventions.map(toIntervention),
    payment: {
      plan: row.paymentPlan as unknown as PaymentPlan,
      total: row.paymentTotal,
      depositPercent: row.depositPercent,
      depositAmount: row.depositAmount,
      payments: row.payments.map((payment) => ({
        id: payment.id,
        amount: payment.amount,
        method: payment.method as PaymentMethod,
        reference: payment.reference,
        recordedBy: payment.recordedBy,
        recordedAt: payment.recordedAt,
        idempotencyKey: payment.idempotencyKey,
      })),
    },
    cancellationReason: row.cancellationReason,
    daysPerWeek: row.daysPerWeek,
    suspension:
      row.suspensionCause && row.suspendedSince
        ? {
            // Liste vide ou sans la cause principale : écrite par une version antérieure à
            // l'ADR-030, qui ne connaissait qu'une cause.
            causes: (row.suspensionCauses.includes(row.suspensionCause)
              ? row.suspensionCauses
              : [row.suspensionCause]) as SuspensionCause[],
            since: row.suspendedSince,
            unpaidCount: row.suspensionUnpaid ?? 0,
          }
        : null,
    warningLevel: row.warningLevel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** Colonnes d'une nouvelle mission (acceptation du devis). */
export function missionCreateColumns(mission: Mission, acceptanceKey: string) {
  return {
    id: mission.id,
    requestId: mission.requestId,
    quoteId: mission.quoteId,
    acceptanceKey,
    customerId: mission.customerId,
    organizationId: mission.organizationId,
    status: mission.status,
    serviceCode: mission.serviceCode,
    commune: mission.commune,
    address: mission.address,
    chosenSlotStart: mission.chosenSlot.start,
    chosenSlotEnd: mission.chosenSlot.end,
    recurrence: recurrenceToJson(mission.recurrence),
    plannedInterventions: mission.plannedInterventions,
    paymentPlan: json(mission.payment.plan),
    paymentTotal: mission.payment.total,
    depositPercent: mission.payment.depositPercent,
    depositAmount: mission.payment.depositAmount,
    cancellationReason: mission.cancellationReason,
    daysPerWeek: mission.daysPerWeek,
    ...suspensionColumns(mission),
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

export function interventionColumns(missionId: string, intervention: Intervention) {
  return {
    id: intervention.id,
    missionId,
    status: intervention.status,
    scheduledStart: intervention.scheduledStart,
    scheduledEnd: slotFrom(intervention.scheduledStart, intervention.durationMinutes).end,
    durationMinutes: intervention.durationMinutes,
    agentIds: intervention.agentIds,
    checklist: json(intervention.checklist),
    incidentNote: intervention.incidentNote,
    beforePhotoFileIds: intervention.beforePhotoFileIds,
    afterPhotoFileIds: intervention.afterPhotoFileIds,
    startedAt: intervention.startedAt,
    completedAt: intervention.completedAt,
    cancellationCause: intervention.cancellationCause,
    cancelledAt: intervention.cancelledAt,
  };
}

/** Colonnes de la suspension (plus ancienne cause et liste des causes) et du dernier avertissement. */
export function suspensionColumns(mission: Pick<Mission, 'suspension' | 'warningLevel'>) {
  return {
    suspensionCause: mission.suspension?.causes[0] ?? null,
    suspensionCauses: mission.suspension?.causes ?? [],
    suspendedSince: mission.suspension?.since ?? null,
    suspensionUnpaid: mission.suspension?.unpaidCount ?? null,
    warningLevel: mission.warningLevel,
  };
}
