import { type Prisma } from '../../../../prisma/generated';
import {
  type PlanKind,
  type ProgramCleaningType,
  type ProgramRecord,
  type SessionAgent,
  type SessionRecord,
} from '../../../application/execution/execution.ports';
import { effectiveAssignmentStatus, IN_FORCE_STATUSES } from '../../../domain/planning/assignment-status';
import { type ChecklistPoint, type Incident } from '../../../domain/sessions/session';

/**
 * Lecture des lignes Prisma du lot E (programmes, séances) en enregistrements de l'application.
 * Position et repère restent chiffrés ; seuls les identifiants, les montants et les dates circulent.
 */

export const PROGRAM_INCLUDE = {
  request: {
    select: {
      number: true,
      submittedBy: true,
      items: { select: { offer: { select: { cleaningType: true } } } },
    },
  },
  place: { select: { name: true, placeTypeId: true, placeType: { select: { name: true } } } },
  zone: { select: { name: true } },
  suspensionCauseHistory: { where: { liftedAt: null }, orderBy: { since: 'asc' as const } },
} satisfies Prisma.ProgramInclude;

export type ProgramRow = Prisma.ProgramGetPayload<{ include: typeof PROGRAM_INCLUDE }>;

export interface ProgramStats {
  sessionsCount: number;
  sessionsCompleted: number;
  firstSessionAt: Date | null;
  lastSessionAt: Date | null;
}

function planKindOf(plan: unknown): PlanKind {
  const kind = (plan as { kind?: unknown } | null)?.kind;
  return kind === 'weekly' || kind === 'monthly' ? kind : 'one_off';
}

function checklistOf(template: unknown): { code: string; label: string }[] {
  if (!Array.isArray(template)) return [];
  return [...(template as { code?: unknown; label?: unknown; order?: unknown }[])]
    .filter((item) => typeof item?.code === 'string' && typeof item?.label === 'string')
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map((item) => ({ code: item.code as string, label: item.label as string }));
}

export function toProgram(
  row: ProgramRow,
  stats: ProgramStats,
  pending: { requestedBy: string; requestedAt: Date } | null,
): ProgramRecord {
  const cleaningTypes: ProgramCleaningType[] = row.request.items.map(({ offer }) => ({
    id: offer.cleaningType.id,
    code: offer.cleaningType.code,
    name: offer.cleaningType.name,
    checklist: checklistOf(offer.cleaningType.checklistTemplate),
  }));
  const pendingCancellation =
    row.status !== 'cancelled' && row.cancellationReason && !row.cancelledAt && pending
      ? { reason: row.cancellationReason, ...pending }
      : null;
  return {
    id: row.id,
    number: row.number,
    requestId: row.requestId,
    requestNumber: row.request.number,
    quoteId: row.quoteId,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    customerId: row.ownerKind === 'user' ? row.ownerId : row.request.submittedBy,
    organizationId: row.ownerKind === 'organization' ? row.ownerId : null,
    payerKind: row.payerKind,
    placeId: row.placeId,
    placeName: row.place.name,
    placeTypeId: row.place.placeTypeId,
    placeTypeName: row.place.placeType.name,
    communeKey: row.communeKey,
    communeName: row.zone.name,
    status: row.status,
    causes: row.suspensionCauseHistory.map((cause) => ({
      cause: cause.cause,
      since: cause.since,
      reason: cause.reason,
      decidedBy: cause.decidedBy,
    })),
    suspendedAt: row.suspendedAt,
    sessionPrice: row.sessionPrice,
    teamSize: row.teamSize,
    durationMinutes: row.durationMinutes,
    schedulePlan: row.schedulePlan,
    planKind: planKindOf(row.schedulePlan),
    visitFeeToDeduct: row.visitFeeToDeduct,
    ...stats,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    pendingCancellation,
    cleaningTypes,
    createdAt: row.createdAt,
    version: row.version,
  };
}

export const SESSION_INCLUDE = {
  assignments: {
    where: { status: { in: ['proposed', 'pending_confirmation', 'confirmed'] } },
    include: { agent: { select: { userId: true } } },
    orderBy: [{ isLead: 'desc' as const }, { createdAt: 'asc' as const }],
  },
  incidents: { orderBy: { occurredAt: 'asc' as const } },
  reschedules: { orderBy: { createdAt: 'asc' as const } },
  claims: { select: { id: true, status: true }, orderBy: { id: 'asc' as const } },
} satisfies Prisma.SessionInclude;

export type SessionRow = Prisma.SessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

const CONFIRMATION = {
  confirmed: 'confirmed',
  pending_confirmation: 'pending',
  proposed: 'proposed',
} as const;

function agentsOf(row: SessionRow, now: Date): SessionAgent[] {
  return row.assignments
    .filter((assignment) =>
      IN_FORCE_STATUSES.includes(
        effectiveAssignmentStatus(
          { status: assignment.status, respondBefore: assignment.responseDueAt },
          now,
        ),
      ),
    )
    .map((assignment) => ({
      assignmentId: assignment.id,
      agentId: assignment.agentId,
      userId: assignment.agent.userId,
      isLead: assignment.isLead,
      confirmation: CONFIRMATION[assignment.status as keyof typeof CONFIRMATION],
    }));
}

function checklistPoints(value: unknown): ChecklistPoint[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[]).map((point) => ({
    cleaningTypeCode: (point.cleaningTypeCode as string | null | undefined) ?? null,
    code: String(point.code),
    label: String(point.label ?? ''),
    checked: point.checked === true,
    checkedAt: typeof point.checkedAt === 'string' ? new Date(point.checkedAt) : null,
  }));
}

/** Liste de contrôle enregistrée (JSON) : heures en ISO 8601. */
export function checklistJson(points: readonly ChecklistPoint[]): Prisma.InputJsonValue {
  return points.map((point) => ({
    cleaningTypeCode: point.cleaningTypeCode,
    code: point.code,
    label: point.label,
    checked: point.checked,
    checkedAt: point.checkedAt ? point.checkedAt.toISOString() : null,
  }));
}

function incidentOf(row: SessionRow['incidents'][number]): Incident {
  return {
    id: row.id,
    category: row.kind,
    note: row.note,
    photoFileIds: row.photoFileIds,
    reportedBy: row.reportedBy,
    occurredAt: row.occurredAt,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
  };
}

export function toSession(row: SessionRow, now: Date): SessionRecord {
  const agentDetails = agentsOf(row, now);
  return {
    id: row.id,
    programId: row.programId,
    rank: row.rank,
    communeKey: row.communeKey,
    status: row.status,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    agents: agentDetails.map((agent) => ({ agentId: agent.agentId, isLead: agent.isLead })),
    agentDetails,
    arrivedAt: row.arrivedAt,
    // Le contrôle d'arrivée complet (précisions) se relit de la position chiffrée.
    arrival: row.arrivedAt
      ? {
          distanceMeters: row.arrivalDistanceM,
          alert: false,
          placeAccuracyMeters: null,
          arrivalAccuracyMeters: null,
          uncertain: false,
        }
      : null,
    arrivalGpsEncrypted: row.arrivalGpsEncrypted,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    checklist: checklistPoints(row.checklist),
    beforePhotoFileIds: row.beforePhotoFileIds,
    afterPhotoFileIds: row.afterPhotoFileIds,
    incidents: row.incidents.map(incidentOf),
    missed:
      row.status === 'missed' && row.missedCause && row.missedAt
        ? {
            cause: row.missedCause,
            missedAt: row.missedAt,
            waitStartedAt: row.waitStartedAt,
            calledAt: row.calledAt,
            photoFileId: row.missedPhotoFileId,
          }
        : null,
    signatureFileId: row.signatureFileId,
    staffClosure:
      row.closedByStaff && row.closedBy
        ? { closedBy: row.closedBy, reason: row.closedReason ?? '', presentAgentIds: row.presentAgentIds }
        : null,
    price: row.price,
    amountDue: row.amountDue,
    visitFeeDeducted: row.visitFeeDeducted,
    // Entreprise : statut de paiement sans objet (facture mensuelle) ; lu par l'appelant d'après le
    // payeur du programme.
    paymentStatus: row.paymentStatus,
    dueBy: row.paymentDueAt,
    paidAt: row.paidAt,
    invoiceId: row.invoiceId,
    isRedo: row.freeRedoOfClaimId !== null,
    cancellation:
      row.status === 'cancelled' && row.cancelledAt && row.cancelledBy && row.cancelCause
        ? {
            by: row.cancelledBy,
            cause: row.cancelCause,
            late: row.lateCancellation,
            at: row.cancelledAt,
            reason: row.changeReason,
          }
        : null,
    reschedules: row.reschedules.map((line) => ({
      id: line.id,
      previousStart: line.previousStart,
      previousEnd: line.previousEnd,
      newStart: line.newStart,
      newEnd: line.newEnd,
      by: line.requestedBy,
      at: line.createdAt,
      reason: line.reason,
      actorId: line.actorId,
    })),
    rating:
      row.rating !== null && row.ratedAt
        ? { stars: row.rating, comment: row.ratingComment, ratedAt: row.ratedAt }
        : null,
    catchUpSuggestedStart: row.catchUpSuggestedStart,
    remindedAt: row.remindedAt,
    balanceAlertedAt: row.balanceAlertedAt,
    staffingAlertLevel: row.staffingAlertLevel,
    claimIds: row.claims.map((claim) => claim.id),
    openClaim: row.claims.some((claim) => claim.status === 'open' || claim.status === 'in_progress'),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}
