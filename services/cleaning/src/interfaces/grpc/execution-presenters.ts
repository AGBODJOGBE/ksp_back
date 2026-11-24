import { type cleaningV1 } from '@ksp/contracts';
import { type AgentActivityView } from '../../application/execution/agent-activity.use-cases';
import { type ProgramResumptionView } from '../../application/execution/admin-programs.use-cases';
import { type PaymentOutcomeView } from '../../application/execution/customer-programs.use-cases';
import { type ProgramRecord } from '../../application/execution/execution.ports';
import { type SessionDetails } from '../../application/execution/session-views';
import { type ChecklistPoint, type Incident } from '../../domain/sessions/session';

/**
 * Présentation du lot E (programmes, séances, paiements) aux messages de cleaning.proto. Dates en ISO
 * 8601 UTC ; montants en XOF, absents pour qui ne peut pas les voir (agent, personnel sans
 * cleaning.amounts.read) ; noms et références de l'auteur au back-office seulement.
 */
const iso = (date: Date | null | undefined) => (date ? date.toISOString() : undefined);
const xof = (amount: number) => ({ amount, currency: 'XOF' });
const optional = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

export interface Audience {
  /** Montants visibles (client titulaire, personnel avec cleaning.amounts.read). */
  amounts: boolean;
  /** Back-office : noms, auteurs, demande d'arrêt en attente. */
  staff: boolean;
}

export const CUSTOMER: Audience = { amounts: true, staff: false };

function schedule(plan: unknown): cleaningV1.SchedulePlan {
  const value = (plan ?? {}) as Record<string, unknown>;
  const list = <T>(key: string) => (Array.isArray(value[key]) ? (value[key] as T[]) : []);
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : undefined);
  const number = (key: string) => (typeof value[key] === 'number' ? (value[key] as number) : undefined);
  return {
    kind: text('kind') ?? 'one_off',
    startTime: text('startTime') ?? '',
    dates: list<string>('dates'),
    weekdays: list<string>('weekdays'),
    ...optional('everyWeeks', number('everyWeeks')),
    monthDays: list<number>('monthDays'),
    monthWeekdays: list<cleaningV1.MonthWeekday>('monthWeekdays'),
    ...optional('startDate', text('startDate')),
    ...optional('endDate', text('endDate')),
    ...optional('durationWeeks', number('durationWeeks')),
    ...optional('durationMonths', number('durationMonths')),
    excludedDates: list<string>('excludedDates'),
    addedDates: list<string>('addedDates'),
    ...optional(
      'excludeHolidays',
      typeof value.excludeHolidays === 'boolean' ? value.excludeHolidays : undefined,
    ),
  } as cleaningV1.SchedulePlan;
}

export function presentProgram(
  program: ProgramRecord,
  audience: Audience,
  names: Map<string, string> = new Map(),
): cleaningV1.Program {
  return {
    id: program.id,
    number: program.number,
    status: program.status,
    requestId: program.requestId,
    quoteId: program.quoteId,
    customerKind: program.ownerKind === 'user' ? 'individual' : 'organization',
    customerId: program.customerId,
    ...optional('organizationId', program.organizationId),
    payerKind: program.payerKind,
    place: {
      placeId: program.placeId,
      name: program.placeName,
      placeTypeId: program.placeTypeId,
      placeTypeName: program.placeTypeName,
      communeKey: program.communeKey,
      communeName: program.communeName,
    },
    cleaningTypes: program.cleaningTypes.map((type) => ({ id: type.id, code: type.code, name: type.name })),
    schedule: schedule(program.schedulePlan),
    sessionsCount: program.sessionsCount,
    sessionsCompleted: program.sessionsCompleted,
    ...(audience.amounts
      ? { sessionPrice: xof(program.sessionPrice), total: xof(program.sessionPrice * program.sessionsCount) }
      : {}),
    ...optional('firstSessionAt', iso(program.firstSessionAt)),
    ...optional('lastSessionAt', iso(program.lastSessionAt)),
    suspensionCauses:
      program.status === 'suspended'
        ? program.causes.map((cause) => ({
            cause: cause.cause,
            since: cause.since.toISOString(),
            ...optional('reason', cause.reason),
          }))
        : [],
    ...(program.renewal
      ? {
          renewal: {
            status: program.renewal.status,
            proposedAt: program.renewal.proposedAt.toISOString(),
            ...optional('quoteId', program.renewal.quoteId),
            // Proposition sans devis : une nouvelle visite est nécessaire (R-PG-07).
            visitRequired: program.renewal.quoteId === null,
          },
        }
      : {}),
    createdAt: program.createdAt.toISOString(),
    ...(audience.staff && program.pendingCancellation
      ? {
          pendingCancellation: {
            reason: program.pendingCancellation.reason,
            requestedBy: program.pendingCancellation.requestedBy,
            requestedAt: program.pendingCancellation.requestedAt.toISOString(),
          },
        }
      : {}),
    ...(audience.staff ? optional('customerName', names.get(program.customerId)) : {}),
  } as cleaningV1.Program;
}

function checklistItem(point: ChecklistPoint): cleaningV1.ChecklistItem {
  return {
    code: point.code,
    label: point.label,
    ...optional('cleaningTypeCode', point.cleaningTypeCode),
    checked: point.checked,
    ...optional('checkedAt', iso(point.checkedAt)),
  };
}

function photo(view: SessionDetails['photos'][number]): cleaningV1.Photo {
  return {
    fileId: view.fileId,
    kind: view.kind,
    takenAt: view.takenAt.toISOString(),
    ...optional('url', view.url),
    ...optional('urlExpiresAt', iso(view.urlExpiresAt)),
  };
}

function incident(value: Incident): cleaningV1.Incident {
  return {
    id: value.id,
    category: value.category,
    note: value.note,
    photos: value.photoFileIds.map((fileId) => ({
      fileId,
      kind: 'incident',
      takenAt: value.occurredAt.toISOString(),
    })),
    reportedAt: value.occurredAt.toISOString(),
    decision: value.decision,
    ...optional('decidedAt', iso(value.decidedAt)),
  };
}

function arrival(details: SessionDetails): cleaningV1.ArrivalCheck | undefined {
  const { session, arrival: check } = details;
  if (!session.arrivedAt || !check) return undefined;
  return {
    arrivedAt: session.arrivedAt.toISOString(),
    ...optional('distanceMeters', check.distanceMeters),
    alert: check.alert,
    ...optional(
      'placeAccuracyMeters',
      check.placeAccuracyMeters === null ? null : Math.round(check.placeAccuracyMeters),
    ),
    ...optional(
      'arrivalAccuracyMeters',
      check.arrivalAccuracyMeters === null ? null : Math.round(check.arrivalAccuracyMeters),
    ),
    uncertain: check.uncertain,
  };
}

function team(details: SessionDetails): cleaningV1.AssignedAgent[] {
  return details.session.agentDetails.map((agent) => {
    const [firstName = '', ...rest] = (details.names.get(agent.userId) ?? '').split(' ');
    return {
      agentId: agent.agentId,
      firstName,
      lastName: rest.join(' '),
      isLead: agent.isLead || details.session.agentDetails.length === 1,
      confirmation: agent.confirmation,
    };
  });
}

export function presentSession(details: SessionDetails, audience: Audience): cleaningV1.Session {
  const { session, program } = details;
  const individual = program.payerKind === 'individual';
  const amounts = audience.amounts;
  const cancellation = session.cancellation;
  return {
    id: session.id,
    programId: program.id,
    programNumber: program.number,
    rank: session.rank,
    sessionsCount: program.sessionsCount,
    status: session.status,
    scheduledStart: session.scheduledStart.toISOString(),
    scheduledEnd: session.scheduledEnd.toISOString(),
    ...(individual ? optional('paymentStatus', session.paymentStatus) : {}),
    ...(amounts
      ? {
          price: xof(session.price),
          ...(session.amountDue !== null
            ? { amountDue: xof(session.amountDue - session.visitFeeDeducted) }
            : {}),
          visitFeeDeduction: xof(session.visitFeeDeducted),
        }
      : {}),
    ...(individual ? optional('dueBy', iso(session.dueBy)) : {}),
    agents: team(details),
    ...optional('arrival', arrival(details)),
    ...optional('startedAt', iso(session.startedAt)),
    ...optional('completedAt', iso(session.completedAt)),
    checklist: details.checklist.map(checklistItem),
    photos: details.photos.map(photo),
    incidents: session.incidents.map(incident),
    signed: session.signatureFileId !== null,
    ...(session.rating
      ? {
          rating: {
            stars: session.rating.stars,
            ...optional('comment', session.rating.comment),
            ratedAt: session.rating.ratedAt.toISOString(),
          },
        }
      : {}),
    reschedules: session.reschedules.map((line) => ({
      previousStart: line.previousStart.toISOString(),
      newStart: line.newStart.toISOString(),
      by: line.by,
      at: line.at.toISOString(),
      ...(audience.staff || line.by === 'ksp' ? optional('reason', line.reason) : {}),
      ...(audience.staff ? optional('actorId', line.actorId) : {}),
    })),
    ...(cancellation
      ? {
          cancellation: {
            by: cancellation.by,
            late: cancellation.late,
            at: cancellation.at.toISOString(),
            cause: cancellation.cause,
            ...(audience.staff || cancellation.by === 'ksp' ? optional('reason', cancellation.reason) : {}),
          },
        }
      : {}),
    isRedo: session.isRedo,
    ...optional('invoiceId', session.invoiceId),
    claimIds: session.claimIds,
    ...(audience.staff ? optional('customerName', details.names.get(program.customerId)) : {}),
  } as cleaningV1.Session;
}

/** Séance vue par l'agent : sans montants (R-EX-04), lieu seulement pendant la séance (R-EX-06). */
export function presentAgentSession(
  details: SessionDetails & { agentId: string },
): cleaningV1.AgentSessionView {
  const { session, program } = details;
  const me = session.agentDetails.find((agent) => agent.agentId === details.agentId);
  const customer = details.names.get(program.customerId) ?? '';
  return {
    id: session.id,
    programNumber: program.number,
    rank: session.rank,
    status: session.status,
    scheduledStart: session.scheduledStart.toISOString(),
    scheduledEnd: session.scheduledEnd.toISOString(),
    isLead: Boolean(me?.isLead) || session.agentDetails.length === 1,
    team: team(details),
    place: {
      name: program.placeName,
      placeTypeName: program.placeTypeName,
      communeName: program.communeName,
      ...(details.placeLocation
        ? {
            location: {
              latitude: details.placeLocation.latitude,
              longitude: details.placeLocation.longitude,
              landmark: '',
            },
          }
        : {}),
      customerFirstName: customer.split(' ')[0] ?? '',
    },
    checklist: details.checklist.map(checklistItem),
    photos: details.photos.map(photo),
    incidents: session.incidents.map(incident),
    ...optional('arrival', arrival(details)),
    ...optional('startedAt', iso(session.startedAt)),
    ...optional('completedAt', iso(session.completedAt)),
  } as cleaningV1.AgentSessionView;
}

export function presentPaymentOutcome(outcome: PaymentOutcomeView): cleaningV1.PaymentOutcome {
  return {
    status: outcome.status,
    amount: xof(outcome.amount),
    ...optional('walletTransactionId', outcome.walletTransactionId),
    ...optional('paymentId', outcome.paymentId),
    ...optional('checkoutUrl', outcome.checkoutUrl),
    ...optional('invoiceId', outcome.invoiceId),
  };
}

export function presentResumption(
  view: ProgramResumptionView,
  audience: Audience,
): cleaningV1.ProgramResumption {
  return {
    program: presentProgram(view.program, audience),
    catchUp: view.catchUp.map((proposal) => ({
      sessionId: proposal.sessionId,
      rank: proposal.rank,
      previousStart: proposal.previousStart.toISOString(),
      ...optional('suggestedStart', iso(proposal.suggestedStart)),
    })),
  };
}

export function presentActivity(view: AgentActivityView): cleaningV1.AgentActivity {
  return {
    stats: {
      sessionsCompleted: view.stats.sessionsCompleted,
      visitsCompleted: view.stats.visitsCompleted,
      hoursThisWeek: view.stats.hoursThisWeek,
      hoursThisMonth: view.stats.hoursThisMonth,
      ...optional('ratingAverage', view.stats.ratingAverage),
      ratingsCount: view.stats.ratingsCount,
      openClaims: view.stats.openClaims,
    },
    weeks: view.weeks,
    months: view.months,
  };
}
