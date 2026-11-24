import { AppError } from '@ksp/platform';
import { addDays } from '../../domain/planning/time';
import { type ParameterValue } from '../../domain/pricing/types';
import {
  type RenewalProgram,
  renewalStartDate,
  renewProgram,
  reorderProgram,
} from '../../domain/programs/renewal';
import { renewedPlan } from '../../domain/programs/renewal-plan';
import { composeProgramQuote, sendProgramQuote } from '../../domain/quotes/program-quote';
import { effectiveQuoteStatus, type PricedLine } from '../../domain/quotes/quote';
import { quoteLinesFrom } from '../../domain/quotes/quote-lines';
import { defaultVisitSlot, submitFollowUpRequest } from '../../domain/requests/follow-up-request';
import { countOpenRequests, isOpenRequest } from '../../domain/requests/request-status';
import { addHours, localDay } from '../../domain/requests/time';
import { type SchedulePlan } from '../../domain/schedule-plan/plan';
import { type ExecutionDeps } from '../deps';
import { executionErrors } from '../execution/execution-errors';
import { type ProgramRecord, type SessionRecord } from '../execution/execution.ports';
import { CleaningErrors, cleaningErrors } from '../shared/errors';
import { type IdempotencyStub, runIdempotent } from '../shared/idempotency';
import { requireUuid } from '../shared/input';
import { lotGErrors } from '../shared/lot-g.errors';
import { previewSchedule, type SchedulePlanInput, toSchedulePlan } from '../simulation/schedule';
import { simulate } from '../simulation/simulate.use-cases';
import { caseErrors, decide } from './case-errors';
import { planInput, priceCase } from './case-pricing';
import { audit, caseParty, catalogNames, iso, money, saveCase, sentQuote, timelineOf } from './case-support';
import { currentCustomer, type Customer, ownedBy } from './customer';
import { programRevision } from './program-quotes.use-cases';
import { decryptLocation, encryptLocation } from './locations';
import { requireActor } from './places.use-cases';
import { CLEANING_TERMS_VERSION } from './quotes-admin.use-cases';
import {
  type CaseRecord,
  type DeclaredRow,
  type QuoteRecord,
  type RequestRecord,
  type RevisionRecord,
} from './requests.ports';
import { debitVisitFee, submittedEvent } from './visit-fee-money';

/**
 * UC-NT-18 — Renouveler un programme (R-PG-07) et commander à nouveau (R-PG-08), et proposition
 * automatique de renouvellement 14 jours avant la fin. Dernier constat de moins de 12 mois : pas de
 * nouvelle visite (devis de renouvellement envoyé sur la demande du programme, ou nouvelle demande
 * née « devis à composer »). Sinon : nouvelle demande qui suit le parcours normal avec visite ; le
 * créneau de la visite est convenu avec la supervision, ces appels ne portant pas de créneaux.
 */
const SYSTEM_ACTOR = 'system';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dernier constat du dossier : la visite réalisée la plus récente. Une demande née d'une nouvelle
 * commande sans visite n'a ni frais ni visite : sa version retenue, recopiée du programme d'origine,
 * porte la date du constat d'origine.
 */
export function lastObservationAt(record: CaseRecord): Date | null {
  const observed = record.visits
    .filter((visit) => visit.status === 'completed')
    .map((visit) => visit.observedAt ?? visit.completedAt)
    .filter((date): date is Date => date !== null);
  if (observed.length) return new Date(Math.max(...observed.map((date) => date.getTime())));
  if (record.visits.length === 0 && record.fees.length === 0)
    return record.revisions.find((revision) => revision.revision === 1)?.createdAt ?? null;
  return null;
}

/** Ce que le domaine doit savoir du programme pour décider (R-PG-07, R-PG-08). */
export function renewalView(program: ProgramRecord, sessions: readonly SessionRecord[]): RenewalProgram {
  const starts = sessions
    .filter((session) => session.status !== 'cancelled')
    .map((session) => session.scheduledStart.getTime());
  return {
    status: program.status,
    planKind: program.planKind,
    lastSessionStart: starts.length ? new Date(Math.max(...starts)) : null,
    renewedBy: program.renewedByProgramId,
  };
}

export type AutomaticProposal = 'quote' | 'visit_required' | 'skipped';

export class ProgramRenewalUseCases {
  constructor(private readonly deps: ExecutionDeps) {}

  /** RenewProgram — administrateur seulement dans une organisation (R-CP-03). */
  async renew(input: {
    programId: string;
    idempotencyKey: string;
    startDate?: string | undefined;
  }): Promise<CaseRecord> {
    const customer = currentCustomer();
    const program = await this.ownedProgram(customer, input.programId);
    if (customer.role !== null && customer.role !== 'org_admin') throw executionErrors.orgRoleRequired();
    const startDate = input.startDate || null;
    if (startDate && !DAY_PATTERN.test(startDate)) throw cleaningErrors.invalid('startDate', 'invalid_type');
    const now = this.deps.clock.now();
    return this.idempotent(
      customer,
      'program.renew',
      input.idempotencyKey,
      { programId: program.id, startDate },
      now,
      async (stub) => {
        const { fresh, sessions, record } = await this.situation(program.id);
        const decision = renewProgram(renewalView(fresh, sessions), now, lastObservationAt(record));
        if (!decision.ok) throw lotGErrors.renewalNotAllowed(decision.reason);
        if (!decision.value.withVisit && programRevision(record, fresh)) {
          const proposed = await this.proposeByQuote(fresh, sessions, record, {
            actorId: customer.userId,
            startDate,
            now,
            stub,
            automatic: false,
          });
          return { requestId: proposed.request.id, debit: false };
        }
        // Nouvelle visite : une demande déjà ouverte pour ce lieu depuis la proposition est rendue
        // telle quelle, jamais doublée.
        const open = await this.deps.cases.openCandidates(customer.owner);
        const since = fresh.renewal?.proposedAt ?? null;
        const pending = open.find(
          (item) =>
            item.request.placeId === fresh.placeId &&
            since !== null &&
            item.request.createdAt >= since &&
            isOpenRequest(timelineOf(item), now),
        );
        if (pending) return { requestId: pending.request.id, debit: false };
        const plan = this.renewalPlan(fresh, sessions, startDate, now, await this.leadHours());
        const created = await this.followUp(customer, fresh, record, {
          plan: await plan,
          withVisit: true,
          action: 'request.renewal_submitted',
          now,
          stub,
        });
        await this.deps.cases.proposeRenewalWithoutQuote(fresh.id, now, { events: [], audit: [] });
        return created;
      },
    );
  }

  /** ReorderProgram — membre au moins dans une organisation (R-CP-03). */
  async reorder(input: {
    programId: string;
    idempotencyKey: string;
    schedule?: SchedulePlanInput | undefined;
  }): Promise<CaseRecord> {
    const customer = currentCustomer();
    const program = await this.ownedProgram(customer, input.programId);
    requireActor(customer);
    if (!input.schedule) throw CleaningErrors.validation('schedule', 'required');
    const plan = toSchedulePlan(input.schedule);
    const now = this.deps.clock.now();
    return this.idempotent(
      customer,
      'program.reorder',
      input.idempotencyKey,
      { programId: program.id, schedule: plan },
      now,
      async (stub) => {
        const { fresh, sessions, record } = await this.situation(program.id);
        const decision = reorderProgram(renewalView(fresh, sessions), now, lastObservationAt(record));
        if (!decision.ok) throw lotGErrors.renewalNotAllowed(decision.reason);
        return this.followUp(customer, fresh, record, {
          plan,
          withVisit: decision.value.withVisit || !programRevision(record, fresh),
          action: 'request.reordered',
          now,
          stub,
        });
      },
    );
  }

  /**
   * Proposition automatique (tâche planifiée, acteur `system`) : devis de renouvellement envoyé si le
   * dernier constat a moins de 12 mois, sinon proposition sans devis (nouvelle visite à prévoir).
   * Une seule par programme : l'écriture est conditionnée par l'absence de proposition.
   */
  async proposeAutomatically(programId: string, now: Date): Promise<AutomaticProposal> {
    const { fresh, sessions, record } = await this.situation(programId);
    if (fresh.renewal || fresh.renewedByProgramId) return 'skipped';
    const decision = renewProgram(renewalView(fresh, sessions), now, lastObservationAt(record));
    if (!decision.ok) return 'skipped';
    const withoutQuote = (details: Record<string, unknown>) =>
      this.deps.cases.proposeRenewalWithoutQuote(fresh.id, now, {
        events: [],
        audit: [audit(SYSTEM_ACTOR, 'program.renewal_proposed', 'program', fresh.id, now, details)],
      });
    if (decision.value.withVisit || !programRevision(record, fresh)) {
      return (await withoutQuote({ visitRequired: true })) ? 'visit_required' : 'skipped';
    }
    try {
      await this.proposeByQuote(fresh, sessions, record, {
        actorId: SYSTEM_ACTOR,
        startDate: null,
        now,
        automatic: true,
      });
      return 'quote';
    } catch (error) {
      if (error instanceof AppError && error.code === 'CLEANING_CONCURRENT_UPDATE') return 'skipped';
      // Devis impossible à composer (offre retirée, plan hors bornes…) : proposition sans devis,
      // pour ne pas réessayer à chaque passage ; l'erreur reste comptée.
      await withoutQuote({ visitRequired: false, quoteFailed: true });
      throw error;
    }
  }

  // --- Devis de renouvellement ------------------------------------------------------------------

  /**
   * Devis « renewal » sur la demande du programme : mêmes types, mêmes valeurs retenues, même plan
   * recalé, même nombre de séances, même équipe et même durée, tarifs du jour (les remises manuelles
   * du devis d'origine ne sont pas reprises), envoyé aussitôt. Une proposition envoyée et encore
   * valable est rendue telle quelle.
   */
  private async proposeByQuote(
    program: ProgramRecord,
    sessions: readonly SessionRecord[],
    record: CaseRecord,
    input: {
      actorId: string;
      startDate: string | null;
      now: Date;
      stub?: IdempotencyStub;
      automatic: boolean;
    },
  ): Promise<CaseRecord> {
    const { now } = input;
    const valid = record.quotes.find(
      (quote) =>
        quote.kind === 'renewal' &&
        quote.programId === program.id &&
        effectiveQuoteStatus(quote, now) === 'sent',
    );
    if (valid) return record;
    const revision = programRevision(record, program)!;
    const settings = await this.deps.caseSettings.caseSettings();
    const plan = await this.renewalPlan(
      program,
      sessions,
      input.startDate,
      now,
      settings.firstSessionLeadHours,
    );
    const [preview, priced] = await Promise.all([
      previewSchedule(this.deps, plan),
      priceCase(this.deps, record, {
        values: revision.values as Record<string, ParameterValue>,
        cleaningTypeIds: [...revision.cleaningTypeIds],
        schedule: plan,
      }),
    ]);
    const origin = record.quotes.find((quote) => quote.id === program.quoteId) ?? null;
    const lines = this.linesOf(priced.pricing, origin);
    const draft = decide(() =>
      composeProgramQuote({
        id: this.deps.ids.next(),
        requestId: record.request.id,
        version: record.quotes.reduce((max, quote) => Math.max(max, quote.version), 0) + 1,
        retainedRevision: revision.revision,
        lines,
        basePrice: lines.reduce((sum, line) => sum + line.amount, 0),
        adjustments: [],
        sessionStarts: preview.occurrences.map((occurrence) => occurrence.start),
        teamSize: program.teamSize,
        durationMinutes: program.durationMinutes,
        paymentTerms: record.request.owner.kind === 'organization' ? 'monthly_invoice' : 'per_session',
        termsVersion: CLEANING_TERMS_VERSION,
        discountApprovalThresholdPercent: settings.maxDiscountWithoutApprovalPct,
        firstSessionLeadHours: settings.firstSessionLeadHours,
        // Proposition automatique : l'auteur du devis d'origine reste l'auteur des conditions.
        createdBy: input.automatic ? (origin?.createdBy ?? program.customerId) : input.actorId,
        now,
      }),
    );
    const sent = decide(() =>
      sendProgramQuote({
        quote: draft,
        pending: sentQuote(record),
        validityDays: settings.quoteValidityDays,
        firstSessionLeadHours: settings.firstSessionLeadHours,
        now,
      }),
    );
    const quote: QuoteRecord = {
      ...sent.quote,
      schedulePlan: plan,
      sentBy: null,
      validityDays: null,
      kind: 'renewal',
      programId: program.id,
      createdProgramId: null,
      amendment: null,
    };
    const next: CaseRecord = {
      ...record,
      request: { ...record.request, updatedAt: now },
      quotes: [
        ...record.quotes.map((item) =>
          sent.expired && item.id === sent.expired.id ? { ...item, status: 'expired' as const } : item,
        ),
        quote,
      ],
    };
    const names = await catalogNames(this.deps, record.request.placeTypeId, [...revision.cleaningTypeIds]);
    return saveCase(this.deps, next, record.request.version, {
      changes: {
        events: [
          {
            type: 'cleaning.quote.sent',
            payload: {
              ...caseParty(record.request),
              quoteId: quote.id,
              kind: 'renewal',
              version: quote.version,
              sessionPrice: money(quote.sessionPrice),
              sessionsCount: quote.sessionsCount,
              total: money(quote.total),
              visitFeeDeduction: money(0),
              validUntil: iso(quote.validUntil as Date),
              sentAt: iso(now),
              ...names,
            },
          },
        ],
        audit: [
          audit(input.actorId, 'program.renewal_proposed', 'program', program.id, now, {
            quoteId: quote.id,
            sessionsCount: quote.sessionsCount,
            sessionPrice: quote.sessionPrice,
            total: quote.total,
          }),
        ],
        ...(input.stub ? { idempotency: input.stub({ requestId: record.request.id }) } : {}),
      },
      programRenewal: {
        programId: program.id,
        status: 'proposed',
        at: now,
        by: null,
        onlyIfNone: input.automatic,
      },
    });
  }

  /** Lignes aux tarifs du jour ; une offre « sur devis » garde le prix fixé au devis d'origine. */
  private linesOf(pricing: Parameters<typeof quoteLinesFrom>[0], origin: QuoteRecord | null): PricedLine[] {
    const fixed = new Map(
      (origin?.lines ?? [])
        .filter((line) => line.kind === 'offer')
        .map((line) => [line.offerId, line.amount]),
    );
    return decide(() =>
      quoteLinesFrom({
        ...pricing,
        offers: pricing.offers.map((offer) =>
          offer.price === null && fixed.has(offer.offerId)
            ? { ...offer, price: fixed.get(offer.offerId)! }
            : offer,
        ),
      }),
    );
  }

  /**
   * Plan recalé : à partir de la date demandée, sinon du lendemain de la dernière séance (repoussé
   * au premier jour qui respecte le délai minimum avant une première séance).
   */
  private async renewalPlan(
    program: ProgramRecord,
    sessions: readonly SessionRecord[],
    startDate: string | null,
    now: Date,
    leadHours: number,
  ): Promise<SchedulePlan> {
    const last = renewalView(program, sessions).lastSessionStart;
    const earliest = addDays(localDay(addHours(now, leadHours)), 1);
    const natural = last ? renewalStartDate(last, null) : earliest;
    const start = startDate ?? (natural > earliest ? natural : earliest);
    const count =
      sessions.filter((session) => session.status !== 'cancelled').length || program.sessionsCount;
    const plan = renewedPlan(
      program.schedulePlan as SchedulePlan,
      start,
      count,
      await this.deps.holidays.listHolidays(),
    );
    if (!plan) throw CleaningErrors.scheduleEmpty();
    return plan;
  }

  // --- Nouvelle demande née d'un programme ------------------------------------------------------

  /**
   * Nouvelle demande pour le même lieu, avec les mêmes types et, comme valeurs déclarées, les
   * dernières valeurs retenues. Mêmes contrôles que l'envoi d'une demande (lieu, position, zone
   * desservie, bornes du plan, plafond des demandes ouvertes). Sans visite : version retenue
   * recopiée, datée du constat d'origine, et demande annoncée à la supervision ; avec visite : frais
   * de visite débités aussitôt comme pour une demande (R-FV-02).
   */
  private async followUp(
    customer: Customer,
    program: ProgramRecord,
    source: CaseRecord,
    input: {
      plan: SchedulePlan;
      withVisit: boolean;
      action: 'request.renewal_submitted' | 'request.reordered';
      now: Date;
      stub: IdempotencyStub;
    },
  ): Promise<{ requestId: string; debit: boolean }> {
    const { now, plan } = input;
    const place = await this.deps.clientPlaces.findPlace(source.request.placeId);
    if (!place || place.archivedAt || !ownedBy(customer, place.owner)) throw caseErrors.placeNotFound();
    const location = decryptLocation(this.deps.cipher, 'place', place.id, place);
    if (!location) throw caseErrors.placeLocationMissing();
    const placeType = await this.deps.places.getPlaceType(place.placeTypeId);
    if (!placeType?.active) throw CleaningErrors.placeTypeNotFound();
    const zone = await this.deps.zones.findByCommune(place.communeKey);
    if (!zone?.active) {
      throw caseErrors.zoneNotCovered('commune_not_served', {
        key: place.communeKey,
        name: place.communeKey,
      });
    }
    const [settings, standing, open] = await Promise.all([
      this.deps.caseSettings.caseSettings(),
      customer.organizationId
        ? this.deps.cases.organizationStanding(customer.organizationId)
        : Promise.resolve({ suspended: false, unpaidInvoices: 0 }),
      this.deps.cases.openCandidates(customer.owner),
    ]);
    const retained = programRevision(source, program);
    const values = (retained?.values ?? source.request.declaredValues) as Record<string, ParameterValue>;
    const cleaningTypeIds = retained ? [...retained.cleaningTypeIds] : [...source.request.cleaningTypeIds];
    await previewSchedule(this.deps, plan);
    const pricing = placeType.isOther
      ? null
      : await simulate(
          this.deps,
          {
            placeTypeId: placeType.id,
            cleaningTypeIds,
            values,
            schedule: planInput(plan),
            communeKey: place.communeKey,
          },
          { acceptInactive: false, draftTariffIds: [] },
        );
    const category = pricing ? null : await this.deps.places.getCategory(placeType.categoryId);
    const visitFee =
      pricing?.visitFee ?? (category?.visitFee ?? settings.defaultVisitFee) + (zone.visitFeeSurcharge ?? 0);
    const requestId = this.deps.ids.next();
    const submitted = decide(() =>
      submitFollowUpRequest({
        openCount: countOpenRequests(open.map(timelineOf), now),
        maxOpenRequests: settings.maxOpenRequests,
        organizationSuspended: standing.suspended,
        withVisit: input.withVisit,
        feeId: this.deps.ids.next(),
        feeAmount: visitFee,
        paymentHours: settings.visitFeePaymentHours,
        now,
      }),
    );
    const offers = pricing ? await this.deps.offers.listOffers({ placeTypeId: placeType.id }) : [];
    const published = new Map(
      (pricing ? await this.deps.offers.listTariffs(offers.map((offer) => offer.id)) : [])
        .filter((tariff) => tariff.status === 'published')
        .map((tariff) => [tariff.offerId, tariff.id]),
    );
    const versions = new Map(
      (pricing?.pricing.offers ?? []).map((offer) => [offer.offerId, offer.tariffVersion]),
    );
    const sessionPrice = pricing?.pricing.complete ? pricing.pricing.sessionPrice : null;
    const request: RequestRecord = {
      id: requestId,
      number: '',
      owner: customer.owner,
      submittedBy: customer.userId,
      placeId: place.id,
      placeTypeId: placeType.id,
      ...encryptLocation(this.deps.cipher, 'request', requestId, location, {
        commune: { key: place.communeKey, name: place.communeKey },
        boundariesVersion: place.communeBoundariesVersion,
      }),
      status: submitted.status,
      declaredValues: values,
      declaredRows: await this.rows(values),
      cleaningTypeIds,
      items: cleaningTypeIds
        .map((typeId) => {
          const offer = offers.find((item) => item.cleaningTypeId === typeId);
          const tariffVersionId =
            offer && versions.get(offer.id) !== null ? (published.get(offer.id) ?? null) : null;
          return { offerId: offer?.id ?? '', cleaningTypeId: typeId, tariffVersionId };
        })
        .filter((item) => item.offerId !== ''),
      schedulePlan: plan,
      visitSlots: [defaultVisitSlot(now, settings.minVisitLeadHours)],
      pricingSnapshot: pricing ? pricing.pricing : null,
      estimatedSessionPrice: sessionPrice,
      description: source.request.description,
      comment: null,
      photoFileIds: [],
      closingReason: null,
      closingReasonCode: null,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    const copied: RevisionRecord[] =
      input.withVisit || !retained
        ? []
        : [
            {
              id: this.deps.ids.next(),
              revision: 1,
              reason: null,
              visitId: null,
              values,
              cleaningTypeIds,
              sessionPrice: sessionPrice ?? retained.sessionPrice,
              reasons: [],
              pricingSnapshot: pricing ? pricing.pricing : retained.pricingSnapshot,
              diff: [],
              authorId: customer.userId,
              lockedAt: null,
              // Date du constat d'origine : la validité de 12 mois court depuis la vraie visite.
              createdAt: lastObservationAt(source) ?? now,
              updatedAt: now,
            },
          ];
    const record: CaseRecord = {
      request,
      fees: submitted.fee ? [submitted.fee] : [],
      visits: [],
      revisions: copied,
      quotes: [],
      reactivations: [],
      programId: null,
      programNumber: null,
      programStatus: null,
    };
    const number = await this.deps.cases.insertCase(record, {
      changes: {
        events: [],
        audit: [
          audit(customer.userId, input.action, 'request', requestId, now, {
            programId: program.id,
            placeId: place.id,
            withVisit: input.withVisit,
          }),
        ],
        idempotency: input.stub({ requestId }),
      },
    });
    if (!input.withVisit) {
      // Aucuns frais à payer : la demande est annoncée aussitôt à la supervision (devis à composer).
      const created: CaseRecord = { ...record, request: { ...request, number } };
      await saveCase(this.deps, created, 0, {
        changes: { events: [await submittedEvent(this.deps, created, true)], audit: [] },
      });
    }
    return { requestId, debit: input.withVisit };
  }

  /** Lignes déclarées figées avec les libellés du catalogue du jour (RV-18). */
  private async rows(values: Record<string, ParameterValue>): Promise<DeclaredRow[]> {
    const parameters = await this.deps.parameters.listParameters();
    return Object.entries(values).map(([code, value]) => {
      const parameter = parameters.find((item) => item.code === code);
      return { parameterCode: code, label: parameter?.label ?? code, unit: parameter?.unit ?? null, value };
    });
  }

  // --- Communs -----------------------------------------------------------------------------------

  private async leadHours(): Promise<number> {
    return (await this.deps.caseSettings.caseSettings()).firstSessionLeadHours;
  }

  /** Programme du titulaire du contexte actif, sinon introuvable (R-CP-04). */
  private async ownedProgram(customer: Customer, programId: string): Promise<ProgramRecord> {
    const program = await this.deps.execution.program(requireUuid(programId, 'programId'));
    if (!program || !ownedBy(customer, { kind: program.ownerKind, id: program.ownerId })) {
      throw executionErrors.programNotFound();
    }
    return program;
  }

  private async situation(
    programId: string,
  ): Promise<{ fresh: ProgramRecord; sessions: SessionRecord[]; record: CaseRecord }> {
    const fresh = await this.deps.execution.program(programId);
    const record = fresh ? await this.deps.cases.findCase(fresh.requestId) : null;
    if (!fresh || !record) throw executionErrors.programNotFound();
    return { fresh, sessions: await this.deps.execution.programSessions(programId), record };
  }

  /** Clé d'idempotence, puis demande rendue ; les frais d'une nouvelle demande sont débités après. */
  private async idempotent(
    customer: Customer,
    operation: string,
    key: string,
    body: unknown,
    now: Date,
    run: (stub: IdempotencyStub) => Promise<{ requestId: string; debit: boolean }>,
  ): Promise<CaseRecord> {
    const created = await runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation,
      key,
      body: { ...(body as object), owner: customer.owner },
      at: now,
      replay: async (response) => ({ requestId: String(response.requestId), debit: false }),
      run,
    });
    const record = await this.deps.cases.findCase(created.requestId);
    if (!record) throw caseErrors.requestNotFound();
    const fee = created.debit ? record.fees[0] : undefined;
    if (!fee) return record;
    // R-FV-02 : débit aussitôt ; une panne laisse l'opération en cours, reprise par la tâche des
    // échéances.
    return (await debitVisitFee(this.deps, record, fee, customer.userId, now)).record;
  }
}
