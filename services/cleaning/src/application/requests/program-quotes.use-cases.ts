import { applyAmendment, assertAmendable } from '../../domain/programs/amendment';
import {
  acceptAmendmentQuote,
  acceptProgramQuote,
  declineProgramQuote,
  expireProgramQuote,
  sendAmendmentQuote,
} from '../../domain/quotes/program-quote';
import { type CleaningDeps } from '../deps';
import { executionError, executionErrors } from '../execution/execution-errors';
import { type ProgramRecord } from '../execution/execution.ports';
import { sessionFields } from '../execution/execution-support';
import { type OutboxMessage } from '../ports';
import { type IdempotencyStub } from '../shared/idempotency';
import { lotGErrors } from '../shared/lot-g.errors';
import { decide } from './case-errors';
import {
  audit,
  caseParty,
  catalogNames,
  iso,
  latestRevision,
  money,
  quoteById,
  saveCase,
  sentQuote,
} from './case-support';
import { type AcceptedQuote } from './client-quotes.use-cases';
import { type Customer } from './customer';
import { type CaseRecord, type NewProgram, type QuoteRecord, type RevisionRecord } from './requests.ports';

/**
 * Réponse à un devis rattaché à un programme (renouvellement R-PG-07, avenant R-PG-06). La demande,
 * déjà acceptée, ne change pas : seuls le devis et le programme visé sont écrits, dans la même
 * transaction que les événements et les traces.
 */
const SYSTEM_ACTOR = 'system';

export function isProgramQuote(quote: Pick<QuoteRecord, 'kind'>): boolean {
  return quote.kind === 'renewal' || quote.kind === 'amendment';
}

/** Programme visé par le devis ; il a pu changer depuis l'envoi. */
export async function targetProgram(deps: CleaningDeps, quote: QuoteRecord): Promise<ProgramRecord> {
  const program = quote.programId && deps.execution ? await deps.execution.program(quote.programId) : null;
  if (!program) throw executionErrors.programNotFound();
  return program;
}

async function standingOf(deps: CleaningDeps, customer: Customer) {
  if (!customer.organizationId) return null;
  const [settings, standing] = await Promise.all([
    deps.caseSettings.caseSettings(),
    deps.cases.organizationStanding(customer.organizationId),
  ]);
  return {
    role: customer.role ?? ('org_viewer' as const),
    suspended: standing.suspended,
    unpaidInvoices: standing.unpaidInvoices,
    unpaidInvoicesSuspension: settings.unpaidInvoicesSuspension,
  };
}

/**
 * Acceptation d'un devis de renouvellement : un nouveau programme est créé, lié à l'ancien
 * (`renewalOfProgramId`), toutes ses séances « à affecter » ; l'ancien, qui poursuit sa vie, garde
 * la réponse (acceptée, date, auteur). Un programme annulé, suspendu ou déjà renouvelé depuis
 * l'envoi ne se renouvelle plus (CLEANING_RENEWAL_NOT_ALLOWED).
 */
export async function acceptRenewalQuote(
  deps: CleaningDeps,
  input: {
    record: CaseRecord;
    quote: QuoteRecord;
    customer: Customer;
    startDate: string | null;
    /** Dates décalées par le client (R-AC-01) ; null : celles du devis. */
    sessionStarts: readonly Date[] | null;
    now: Date;
    stub: IdempotencyStub;
  },
): Promise<AcceptedQuote> {
  const { record, quote, customer, now } = input;
  const renewed = await targetProgram(deps, quote);
  if (renewed.renewedByProgramId) throw lotGErrors.renewalNotAllowed('already_renewed');
  if (renewed.status === 'cancelled') throw lotGErrors.renewalNotAllowed('program_closed');
  if (renewed.status === 'suspended') throw lotGErrors.renewalNotAllowed('program_suspended');
  const [settings, organization] = await Promise.all([
    deps.caseSettings.caseSettings(),
    standingOf(deps, customer),
  ]);
  const accepted = decide(() =>
    acceptProgramQuote({
      quote,
      organization,
      startDate: input.startDate,
      ...(input.sessionStarts ? { sessionStarts: input.sessionStarts } : {}),
      firstSessionLeadHours: settings.firstSessionLeadHours,
      userId: customer.userId,
      now,
    }),
  );
  const programId = deps.ids.next();
  const program: NewProgram = {
    id: programId,
    requestId: record.request.id,
    quoteId: quote.id,
    owner: record.request.owner,
    payerKind: accepted.program.payerKind,
    placeId: record.request.placeId,
    communeKey: record.request.communeKey,
    sessionPrice: quote.sessionPrice,
    teamSize: quote.teamSize,
    durationMinutes: quote.durationMinutes,
    schedulePlan: quote.schedulePlan,
    visitFeeToDeduct: 0,
    renewalOfProgramId: renewed.id,
    createdAt: now,
    sessions: accepted.program.sessions.map((session) => ({
      id: deps.ids.next(),
      rank: session.rank,
      scheduledStart: session.scheduledStart,
      scheduledEnd: new Date(session.scheduledStart.getTime() + quote.durationMinutes * 60_000),
      price: session.price,
      visitFeeDeducted: 0,
    })),
  };
  const acceptedQuote: QuoteRecord = { ...quote, ...accepted.quote, createdProgramId: programId };
  const next: CaseRecord = {
    ...record,
    request: { ...record.request, updatedAt: now },
    quotes: record.quotes.map((item) => (item.id === quote.id ? acceptedQuote : item)),
  };
  const names = await catalogNames(deps, record.request.placeTypeId, record.request.cleaningTypeIds);
  const party = caseParty(record.request);
  let programNumber: string | null = null;
  const saved = await saveCase(deps, next, record.request.version, {
    changes: {
      events: [
        {
          type: 'cleaning.quote.accepted',
          payload: {
            ...party,
            quoteId: quote.id,
            programId,
            acceptedBy: customer.userId,
            total: money(accepted.program.total),
            acceptedAt: iso(now),
          },
        },
      ],
      audit: [
        audit(customer.userId, 'quote.accepted', 'quote', quote.id, now, {
          programId,
          renewalOfProgramId: renewed.id,
          total: accepted.program.total,
          visitFeeDeduction: 0,
        }),
      ],
      idempotency: input.stub({ program: JSON.parse(JSON.stringify(program)) as Record<string, unknown> }),
    },
    program,
    programRenewal: { programId: renewed.id, status: 'accepted', at: now, by: customer.userId },
    programEvents: (number) => {
      programNumber = number;
      return [
        {
          type: 'cleaning.program.confirmed',
          payload: {
            ...party,
            programId,
            programNumber: number,
            quoteId: quote.id,
            payerKind: program.payerKind,
            sessionsCount: program.sessions.length,
            sessionPrice: money(program.sessionPrice),
            total: money(accepted.program.total),
            visitFeeDeduction: money(0),
            firstSessionAt: iso(program.sessions[0]!.scheduledStart),
            lastSessionAt: iso(program.sessions.at(-1)!.scheduledStart),
            confirmedAt: iso(now),
            ...names,
          },
        },
      ];
    },
  });
  return { record: saved, quote: acceptedQuote, program: { ...program, number: programNumber } };
}

/** Refus d'un devis de renouvellement ou d'avenant : le dossier reste ouvert au programme. */
export async function declineProgramQuoteOf(
  deps: CleaningDeps,
  input: {
    record: CaseRecord;
    quote: QuoteRecord;
    customer: Customer;
    reasonCode: string | null;
    comment: string | null;
    now: Date;
    stub: IdempotencyStub;
  },
): Promise<{ record: CaseRecord; quote: QuoteRecord }> {
  const { record, quote, customer, now } = input;
  const declined: QuoteRecord = {
    ...quote,
    ...decide(() =>
      declineProgramQuote({
        quote,
        role: customer.role,
        reasonCode: input.reasonCode,
        comment: input.comment,
        userId: customer.userId,
        now,
      }),
    ),
  };
  const next: CaseRecord = {
    ...record,
    request: { ...record.request, updatedAt: now },
    quotes: record.quotes.map((item) => (item.id === quote.id ? declined : item)),
  };
  const saved = await saveCase(deps, next, record.request.version, {
    changes: {
      events: [
        {
          type: 'cleaning.quote.declined',
          payload: {
            ...caseParty(record.request),
            quoteId: quote.id,
            declinedBy: customer.userId,
            reasonCode:
              (declined.declineReasonCode as 'price' | 'schedule' | 'no_longer_needed' | 'other' | null) ??
              null,
            declinedAt: iso(now),
            communeKey: record.request.communeKey,
          },
        },
      ],
      audit: [
        audit(customer.userId, 'quote.declined', 'quote', quote.id, now, {
          kind: quote.kind,
          programId: quote.programId,
        }),
      ],
      idempotency: input.stub({ quoteId: quote.id }),
    },
    ...(quote.kind === 'renewal' && quote.programId
      ? {
          programRenewal: {
            programId: quote.programId,
            status: 'declined' as const,
            at: now,
            by: customer.userId,
          },
        }
      : {}),
  });
  return { record: saved, quote: quoteById(saved, quote.id) };
}

/**
 * Expiration d'un devis de renouvellement ou d'avenant (tâche des échéances) : seul le devis passe
 * « expiré ». La proposition de renouvellement reste ouverte : le client peut la redemander.
 */
export async function expireProgramQuoteOf(
  deps: CleaningDeps,
  record: CaseRecord,
  quote: QuoteRecord,
  now: Date,
): Promise<void> {
  const expired: QuoteRecord = { ...quote, ...decide(() => expireProgramQuote(quote, now)) };
  const names = await catalogNames(deps, record.request.placeTypeId, record.request.cleaningTypeIds);
  await saveCase(
    deps,
    {
      ...record,
      request: { ...record.request, updatedAt: now },
      quotes: record.quotes.map((item) => (item.id === quote.id ? expired : item)),
    },
    record.request.version,
    {
      changes: {
        events: [
          {
            type: 'cleaning.quote.expired',
            payload: {
              ...caseParty(record.request),
              quoteId: quote.id,
              validUntil: iso(quote.validUntil as Date),
              expiredAt: iso(now),
              communeKey: record.request.communeKey,
              total: money(quote.total),
              ...names,
            },
          },
        ],
        audit: [audit(SYSTEM_ACTOR, 'quote.expired', 'quote', quote.id, now, { kind: quote.kind })],
      },
    },
  );
}

// --- Avenant (R-PG-06) -------------------------------------------------------------------------------

/** Exécute une décision du domaine du lot E et traduit ses refus. */
function ruled<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw executionError(error);
  }
}

/**
 * Valeurs et types retenus d'un programme : la révision citée par son dernier avenant accepté, sinon
 * par le devis qui l'a créé. Un avenant préparé mais pas accepté ne compte pas.
 */
export function programRevision(
  record: CaseRecord,
  program: Pick<ProgramRecord, 'id' | 'quoteId'>,
): RevisionRecord | null {
  const amended = [...record.quotes]
    .sort((a, b) => b.version - a.version)
    .find(
      (quote) => quote.kind === 'amendment' && quote.programId === program.id && quote.status === 'accepted',
    );
  const cited = amended ?? record.quotes.find((quote) => quote.id === program.quoteId) ?? null;
  const revision = cited ? record.revisions.find((item) => item.revision === cited.retainedRevision) : null;
  return revision ?? latestRevision(record);
}

/**
 * Envoi d'un devis d'avenant : programme toujours confirmé ou en cours, non suspendu ; le devis
 * d'avenant déjà envoyé pour ce programme est remplacé (révision, R-DV-05).
 */
export async function sendAmendment(
  deps: CleaningDeps,
  input: {
    record: CaseRecord;
    quote: QuoteRecord;
    staffId: string;
    validityDays: number;
    firstSessionLeadHours: number;
    now: Date;
    stub: IdempotencyStub;
  },
): Promise<{ record: CaseRecord; quote: QuoteRecord }> {
  const { record, quote, now } = input;
  const program = await targetProgram(deps, quote);
  ruled(() =>
    assertAmendable({ status: program.status, causes: program.causes.map((cause) => cause.cause) }),
  );
  const pending = sentQuote(record);
  const sent = decide(() =>
    sendAmendmentQuote({
      quote,
      addedStarts: quote.amendment?.addedStarts ?? [],
      pending,
      replaces: pending !== null && pending.kind === 'amendment' && pending.programId === quote.programId,
      validityDays: input.validityDays,
      firstSessionLeadHours: input.firstSessionLeadHours,
      now,
    }),
  );
  const sentRecord: QuoteRecord = { ...quote, ...sent.quote, sentBy: input.staffId };
  const replaced = sent.superseded ?? sent.expired;
  const next: CaseRecord = {
    ...record,
    request: { ...record.request, updatedAt: now },
    quotes: record.quotes.map((item) => {
      if (item.id === quote.id) return sentRecord;
      if (replaced && item.id === replaced.id) return { ...item, status: replaced.status };
      return item;
    }),
  };
  const revision = record.revisions.find((item) => item.revision === quote.retainedRevision);
  const names = await catalogNames(
    deps,
    record.request.placeTypeId,
    revision ? [...revision.cleaningTypeIds] : record.request.cleaningTypeIds,
  );
  const saved = await saveCase(deps, next, record.request.version, {
    changes: {
      events: [
        {
          type: 'cleaning.quote.sent',
          payload: {
            ...caseParty(record.request),
            quoteId: quote.id,
            kind: 'amendment',
            version: quote.version,
            sessionPrice: money(sentRecord.sessionPrice),
            sessionsCount: sentRecord.sessionsCount,
            total: money(sentRecord.total),
            visitFeeDeduction: money(0),
            validUntil: iso(sentRecord.validUntil as Date),
            sentAt: iso(now),
            ...names,
          },
        },
      ],
      audit: [
        audit(input.staffId, 'quote.sent', 'quote', quote.id, now, {
          kind: 'amendment',
          programId: program.id,
          total: sentRecord.total,
          ...(sent.superseded ? { supersededQuoteId: sent.superseded.id } : {}),
        }),
      ],
      idempotency: input.stub({ quoteId: quote.id }),
    },
  });
  return { record: saved, quote: sentRecord };
}

/**
 * Acceptation d'un devis d'avenant : dans la transaction du dossier et sous le verrou du programme,
 * les séances non démarrées et non payées prennent le nouveau prix et la nouvelle durée, les séances
 * ajoutées sont créées à la suite, les types ajoutés rejoignent le programme, qui reprend le prix,
 * l'équipe, la durée et le plan du devis. Aucun programme n'est créé. Programme suspendu, terminé ou
 * annulé depuis l'envoi : refusé (CLEANING_PROGRAM_SUSPENDED, CLEANING_INVALID_TRANSITION).
 */
export async function acceptAmendmentQuoteOf(
  deps: CleaningDeps,
  input: { record: CaseRecord; quote: QuoteRecord; customer: Customer; now: Date; stub: IdempotencyStub },
): Promise<AcceptedQuote> {
  const { record, quote, customer, now } = input;
  const program = await targetProgram(deps, quote);
  const sessions = await deps.execution!.programSessions(program.id);
  const [settings, organization] = await Promise.all([
    deps.caseSettings.caseSettings(),
    standingOf(deps, customer),
  ]);
  const addedStarts = quote.amendment?.addedStarts ?? [];
  const acceptedQuote: QuoteRecord = {
    ...quote,
    ...decide(() =>
      acceptAmendmentQuote({
        quote,
        organization,
        addedStarts,
        firstSessionLeadHours: settings.firstSessionLeadHours,
        userId: customer.userId,
        now,
      }),
    ),
  };
  const applied = ruled(() =>
    applyAmendment(
      {
        status: program.status,
        causes: program.causes.map((cause) => cause.cause),
        teamSize: program.teamSize,
        durationMinutes: program.durationMinutes,
      },
      sessions,
      {
        sessionPrice: quote.sessionPrice,
        teamSize: quote.teamSize,
        durationMinutes: quote.durationMinutes,
        addedStarts,
      },
    ),
  );
  const addedTypeIds = quote.amendment?.addedCleaningTypeIds ?? [];
  const offerIds = [
    ...new Set(
      quote.lines
        .filter((line) => line.kind === 'offer' && addedTypeIds.includes(line.cleaningTypeId))
        .map((line) => line.offerId),
    ),
  ];
  const published = new Map(
    (offerIds.length ? await deps.offers.listTariffs(offerIds) : [])
      .filter((tariff) => tariff.status === 'published')
      .map((tariff) => [tariff.offerId, tariff.id]),
  );
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const addedSessions = applied.added.map((session) => ({ id: deps.ids.next(), ...session }));
  const total = quote.sessionPrice * applied.sessionsCount;
  const after = { ...program, sessionsCount: program.sessionsCount + addedSessions.length };
  // Équipe ou durée changée : les agents des séances planifiées sont retirés et prévenus.
  const releases: OutboxMessage[] = applied.updated
    .filter((item) => item.release && byId.get(item.sessionId)!.agents.length > 0)
    .map((item) => {
      const session = byId.get(item.sessionId)!;
      return {
        type: 'cleaning.session.unassigned',
        payload: {
          ...sessionFields(after, session),
          agentIds: session.agents.map((agent) => agent.agentId),
          cause: 'manual',
          unassignedAt: iso(now),
          scheduledStart: iso(session.scheduledStart),
          batchId: null,
        },
      };
    });
  const next: CaseRecord = {
    ...record,
    request: { ...record.request, updatedAt: now },
    quotes: record.quotes.map((item) => (item.id === quote.id ? acceptedQuote : item)),
  };
  const view: NewProgram = {
    id: program.id,
    requestId: record.request.id,
    quoteId: program.quoteId,
    owner: record.request.owner,
    payerKind: program.payerKind,
    placeId: program.placeId,
    communeKey: program.communeKey,
    sessionPrice: quote.sessionPrice,
    teamSize: quote.teamSize,
    durationMinutes: quote.durationMinutes,
    schedulePlan: quote.schedulePlan,
    visitFeeToDeduct: program.visitFeeToDeduct,
    createdAt: program.createdAt,
    sessions: [
      ...applied.updated.map((item) => {
        const session = byId.get(item.sessionId)!;
        return {
          id: session.id,
          rank: session.rank,
          scheduledStart: session.scheduledStart,
          scheduledEnd: item.scheduledEnd,
          price: item.price,
          visitFeeDeducted: session.visitFeeDeducted,
        };
      }),
      ...addedSessions.map((session) => ({ ...session, visitFeeDeducted: 0 })),
    ].sort((a, b) => a.rank - b.rank),
  };
  const saved = await saveCase(deps, next, record.request.version, {
    changes: {
      events: [
        {
          type: 'cleaning.quote.accepted',
          payload: {
            ...caseParty(record.request),
            quoteId: quote.id,
            programId: program.id,
            acceptedBy: customer.userId,
            total: money(total),
            acceptedAt: iso(now),
          },
        },
        ...releases,
      ],
      audit: [
        audit(customer.userId, 'quote.accepted', 'quote', quote.id, now, {
          kind: 'amendment',
          programId: program.id,
          total,
          previousSessionPrice: program.sessionPrice,
          sessionPrice: quote.sessionPrice,
          updatedSessionIds: applied.updated.map((item) => item.sessionId),
          addedSessionIds: addedSessions.map((session) => session.id),
          addedCleaningTypeIds: addedTypeIds,
        }),
      ],
      idempotency: input.stub({ program: JSON.parse(JSON.stringify(view)) as Record<string, unknown> }),
    },
    programAmendment: {
      programId: program.id,
      expectedVersion: program.version,
      sessionPrice: quote.sessionPrice,
      teamSize: quote.teamSize,
      durationMinutes: quote.durationMinutes,
      schedulePlan: quote.schedulePlan,
      communeKey: program.communeKey,
      sessions: applied.updated.map((item) => ({
        id: item.sessionId,
        version: byId.get(item.sessionId)!.version,
        price: item.price,
        scheduledEnd: item.scheduledEnd,
        release: item.release,
      })),
      addedSessions,
      addedItems: offerIds.map((offerId) => ({ offerId, tariffVersionId: published.get(offerId) ?? null })),
      at: now,
      by: customer.userId,
    },
  });
  return { record: saved, quote: acceptedQuote, program: { ...view, number: program.number } };
}
