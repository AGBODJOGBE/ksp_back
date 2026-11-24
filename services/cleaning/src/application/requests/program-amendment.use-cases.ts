import { localPosition } from '../../domain/planning/time';
import { type ParameterValue } from '../../domain/pricing/types';
import {
  amendableSessions,
  applyAmendment,
  assertAmendable,
  requestedAmendment,
} from '../../domain/programs/amendment';
import { composeAmendmentQuote } from '../../domain/quotes/program-quote';
import { type SchedulePlan } from '../../domain/schedule-plan/plan';
import { type ExecutionDeps } from '../deps';
import { executionError, executionErrors } from '../execution/execution-errors';
import { type ProgramRecord } from '../execution/execution.ports';
import { requireStaff } from '../shared/access';
import { runIdempotent } from '../shared/idempotency';
import { requireUuid } from '../shared/input';
import { previewSchedule, type SchedulePlanInput, toSchedulePlan } from '../simulation/schedule';
import { type ValueInput } from '../simulation/simulate.use-cases';
import { caseErrors, decide } from './case-errors';
import { priceCase } from './case-pricing';
import { audit, effectiveQuote, quoteById, saveCase } from './case-support';
import { programRevision } from './program-quotes.use-cases';
import {
  adjustmentsOf,
  CLEANING_TERMS_VERSION,
  linesWith,
  type QuoteDraftInput,
  requireAdjustPermission,
  validity,
} from './quotes-admin.use-cases';
import { type CaseRecord, type QuoteRecord, type RevisionRecord } from './requests.ports';
import { CASE_PERMISSIONS, staffWith } from './staff';

/**
 * UC-NT-39 — Préparer un avenant (R-PG-06, R-EX-03) : devis complémentaire, brouillon, rattaché à la
 * demande du programme, pour ajouter un type de nettoyage ou des séances, sans nouvelle visite. Il
 * décrit le programme après l'avenant : toutes les séances non démarrées et les séances ajoutées,
 * au prix d'une séance avec tous les types, aux tarifs du jour. Il s'envoie, s'accepte, se refuse et
 * expire par les appels existants des devis ; une nouvelle préparation en est la révision.
 */
export interface AmendmentInput extends Omit<QuoteDraftInput, 'schedule'> {
  programId: string;
  idempotencyKey: string;
  addCleaningTypeIds: string[];
  addSchedule?: SchedulePlanInput | undefined;
  values: Record<string, ValueInput>;
}

/** Exécute une décision du domaine du lot E et traduit ses refus. */
function ruled<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw executionError(error);
  }
}

/**
 * Plan du programme après l'avenant : le plan en cours, plus les jours des séances ajoutées (jours
 * de passage d'un ponctuel, jours ajoutés d'un récurrent, R-PG-02).
 */
export function amendedPlan(plan: unknown, addedStarts: readonly Date[]): SchedulePlan {
  const current = (plan ?? {}) as Partial<SchedulePlan>;
  const days = addedStarts.map((start) => localPosition(start).day);
  const merge = (list: readonly string[] | undefined) => [...new Set([...(list ?? []), ...days])].sort();
  return {
    ...(current as SchedulePlan),
    ...(current.kind === 'weekly' || current.kind === 'monthly'
      ? { addedDates: merge(current.addedDates) }
      : { dates: merge(current.dates) }),
  };
}

export class ProgramAmendmentUseCases {
  constructor(private readonly deps: ExecutionDeps) {}

  async create(input: AmendmentInput): Promise<{ record: CaseRecord; quote: QuoteRecord }> {
    requireStaff();
    const program = await this.program(input.programId);
    const staffId = staffWith(CASE_PERMISSIONS.quoteManage, program.communeKey);
    const adjustments = adjustmentsOf(input.adjustments);
    requireAdjustPermission(adjustments, program.communeKey);
    const validityDays = validity(input.validityDays);
    const addTypeIds = input.addCleaningTypeIds.map((id, index) =>
      requireUuid(id, `addCleaningTypeIds[${index}]`),
    );
    const addPlan = input.addSchedule ? toSchedulePlan(input.addSchedule) : null;
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'program.amendment_create',
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      at: now,
      replay: async (response) => this.view(String(response.quoteId)),
      run: async (stub) => {
        const fresh = await this.program(program.id);
        ruled(() =>
          assertAmendable({ status: fresh.status, causes: fresh.causes.map((cause) => cause.cause) }),
        );
        const [sessions, record, settings] = await Promise.all([
          this.deps.execution.programSessions(fresh.id),
          this.deps.cases.findCase(fresh.requestId),
          this.deps.caseSettings.caseSettings(),
        ]);
        if (!record) throw executionErrors.programNotFound();
        const preview = addPlan ? await previewSchedule(this.deps, addPlan) : null;
        const requested = ruled(() =>
          requestedAmendment({
            currentTypeIds: fresh.cleaningTypes.map((type) => type.id),
            addTypeIds,
            addedStarts: preview?.occurrences.map((occurrence) => occurrence.start) ?? [],
            sessions,
          }),
        );
        const base = programRevision(record, fresh);
        const values = { ...(base?.values ?? record.request.declaredValues), ...input.values } as Record<
          string,
          ParameterValue
        >;
        const cleaningTypeIds = [
          ...(base ? base.cleaningTypeIds : record.request.cleaningTypeIds),
          ...requested.addedTypeIds,
        ];
        const priced = await priceCase(this.deps, record, { values, cleaningTypeIds });
        // Une offre « sur devis » déjà au programme garde le prix fixé à son devis.
        const origin = record.quotes.find((quote) => quote.id === fresh.quoteId) ?? null;
        const kept = (origin?.lines ?? [])
          .filter((line) => line.kind === 'offer')
          .map((line) => ({ offerId: line.offerId, price: line.amount }));
        const lines = linesWith(priced.pricing, [...kept, ...(input.onQuotePrices ?? [])]);
        const basePrice = lines.reduce((sum, line) => sum + line.amount, 0);
        const revisionNumber = record.revisions.reduce((max, item) => Math.max(max, item.revision), 0) + 1;
        const quote = decide(() =>
          composeAmendmentQuote({
            id: this.deps.ids.next(),
            requestId: record.request.id,
            version: record.quotes.reduce((max, item) => Math.max(max, item.version), 0) + 1,
            retainedRevision: revisionNumber,
            lines,
            basePrice,
            adjustments,
            remainingStarts: amendableSessions(sessions).map((session) => session.scheduledStart),
            addedStarts: requested.addedStarts,
            teamSize: input.teamSize ?? priced.pricing.teamSize ?? fresh.teamSize,
            durationMinutes: input.durationMinutes ?? priced.pricing.durationMinutes ?? fresh.durationMinutes,
            paymentTerms: record.request.owner.kind === 'organization' ? 'monthly_invoice' : 'per_session',
            termsVersion: CLEANING_TERMS_VERSION,
            discountApprovalThresholdPercent: settings.maxDiscountWithoutApprovalPct,
            firstSessionLeadHours: settings.firstSessionLeadHours,
            createdBy: staffId,
            now,
          }),
        );
        // Même décision qu'à l'acceptation : un avenant inapplicable n'est pas préparé.
        ruled(() =>
          applyAmendment(
            {
              status: fresh.status,
              causes: fresh.causes.map((cause) => cause.cause),
              teamSize: fresh.teamSize,
              durationMinutes: fresh.durationMinutes,
            },
            sessions,
            {
              sessionPrice: quote.sessionPrice,
              teamSize: quote.teamSize,
              durationMinutes: quote.durationMinutes,
              addedStarts: requested.addedStarts,
            },
          ),
        );
        // Valeurs et types du programme après l'avenant : révision figée d'emblée, citée par le devis.
        const revision: RevisionRecord = {
          id: this.deps.ids.next(),
          revision: revisionNumber,
          reason: 'Avenant',
          visitId: null,
          values,
          cleaningTypeIds,
          sessionPrice: basePrice,
          reasons: [],
          pricingSnapshot: priced.pricing,
          diff: [],
          authorId: staffId,
          lockedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        const draft: QuoteRecord = {
          ...quote,
          schedulePlan: amendedPlan(fresh.schedulePlan, requested.addedStarts),
          sentBy: null,
          validityDays,
          kind: 'amendment',
          programId: fresh.id,
          createdProgramId: null,
          amendment: { addedStarts: requested.addedStarts, addedCleaningTypeIds: requested.addedTypeIds },
        };
        const saved = await saveCase(
          this.deps,
          { ...record, revisions: [...record.revisions, revision], quotes: [...record.quotes, draft] },
          record.request.version,
          {
            changes: {
              events: [],
              audit: [
                audit(staffId, 'program.amendment_created', 'program', fresh.id, now, {
                  quoteId: draft.id,
                  addedCleaningTypeIds: requested.addedTypeIds,
                  addedSessions: requested.addedStarts.length,
                  sessionsCount: draft.sessionsCount,
                  previousSessionPrice: fresh.sessionPrice,
                  sessionPrice: draft.sessionPrice,
                  total: draft.total,
                }),
              ],
              idempotency: stub({ quoteId: draft.id }),
            },
          },
        );
        return { record: saved, quote: draft };
      },
    });
  }

  private async view(quoteId: string): Promise<{ record: CaseRecord; quote: QuoteRecord }> {
    const record = await this.deps.cases.findCaseByQuote(quoteId);
    if (!record) throw caseErrors.quoteNotFound();
    return { record, quote: effectiveQuote(quoteById(record, quoteId), this.deps.clock.now()) };
  }

  private async program(programId: string): Promise<ProgramRecord> {
    const program = await this.deps.execution.program(requireUuid(programId, 'programId'));
    if (!program) throw executionErrors.programNotFound();
    return program;
  }
}
