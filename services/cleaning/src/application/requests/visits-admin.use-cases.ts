import { permissionZones, requireUser } from '@ksp/platform';
import { requestNewVisit } from '../../domain/quotes/quote';
import { type ParameterValue } from '../../domain/pricing/types';
import {
  assertVisitPhotoLimit,
  cancelVisitByKsp,
  completeVisitOnBehalf,
  moveVisit,
  planVisit,
  reportClientAbsent,
  VISIT_STATUSES,
} from '../../domain/visits/visit';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { CreateAssignmentsUseCase } from '../planning/assignment.use-cases';
import { type IdempotencyRecord, type OutboxMessage } from '../ports';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { instant, optionalInstant, page as parsePage, requireUuid, requiredReason } from '../shared/input';
import { decide } from './case-errors';
import {
  audit,
  caseOfVisit,
  caseParty,
  catalogNames,
  effectiveStatus,
  iso,
  money,
  saveCase,
  sentQuote,
  staffCase,
  timelineOf,
} from './case-support';
import { visitCancelledEvent } from './client-requests.use-cases';
import { type CaseRecord, type QuoteRecord, type VisitRecord } from './requests.ports';
import { CASE_PERMISSIONS, staffWith } from './staff';
import { releaseVisitAgents, visitAgents } from './visit-agenda';
import { refundsFor, sendRefunds } from './visit-fee-money';

/** R-FV-01 : frais du jour, catégorie du lieu (ou défaut) plus la majoration de la commune. */
export async function visitFeeOfDay(deps: CleaningDeps, record: CaseRecord): Promise<number> {
  const [placeType, settings, zone] = await Promise.all([
    deps.places.getPlaceType(record.request.placeTypeId),
    deps.caseSettings.caseSettings(),
    deps.zones.findByCommune(record.request.communeKey),
  ]);
  const category = placeType ? await deps.places.getCategory(placeType.categoryId) : null;
  return (category?.visitFee ?? settings.defaultVisitFee) + (zone?.visitFeeSurcharge ?? 0);
}

export function withVisit(record: CaseRecord, visit: VisitRecord): CaseRecord {
  const known = record.visits.some((item) => item.id === visit.id);
  return {
    ...record,
    visits: known
      ? record.visits.map((item) => (item.id === visit.id ? visit : item))
      : [...record.visits, visit],
  };
}

export interface AgentsInput {
  agentIds: string[];
  leadAgentId?: string | null | undefined;
  overrides: { check: string; reason: string }[];
}

/**
 * Événement « visite annoncée » (R-VI-03) : agents affectés, heure, durée ; libellés du catalogue.
 */
async function scheduledEvent(
  deps: CleaningDeps,
  record: CaseRecord,
  visit: VisitRecord,
  agentIds: string[],
  previous: Date | null,
  released: string[],
): Promise<OutboxMessage> {
  const names = await catalogNames(deps, record.request.placeTypeId, record.request.cleaningTypeIds);
  return {
    type: 'cleaning.visit.scheduled',
    payload: {
      ...caseParty(record.request),
      visitId: visit.id,
      agentIds,
      scheduledAt: iso(visit.scheduledStart),
      durationMinutes: visit.durationMinutes,
      previousScheduledAt: previous ? iso(previous) : null,
      releasedAgentIds: released,
      ...names,
    },
  };
}

/** UC-NT-31 — Visites au back-office (R-VI-01 à 08, R-FV-06). */
export class VisitsAdminUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: {
    from?: string | undefined;
    to?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }) {
    staffWith(CASE_PERMISSIONS.read);
    const now = this.deps.clock.now();
    if (input.status && !(VISIT_STATUSES as readonly string[]).includes(input.status)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    const user = requireUser();
    return this.deps.cases.listVisits(
      {
        from: optionalInstant(input.from, 'from') ?? new Date(now.getTime() - 7 * 86_400_000),
        to: optionalInstant(input.to, 'to') ?? new Date(now.getTime() + 60 * 86_400_000),
        ...(input.status ? { statuses: [input.status] } : {}),
        zones: user.permissions === undefined ? 'all' : permissionZones(user, CASE_PERMISSIONS.read),
      },
      parsePage(input.limit, input.cursor),
    );
  }

  /** Affecte les agents à la visite par la planification du lot D (contrôles de 9.4, verrou RV-75). */
  private async assign(visitId: string, agents: AgentsInput, key: string): Promise<string[]> {
    if (!agents.agentIds.length) return [];
    const batch = await new CreateAssignmentsUseCase(this.deps).execute({
      targets: [{ kind: 'visit', id: visitId }],
      agentIds: agents.agentIds,
      leadAgentId: agents.leadAgentId ?? null,
      overrides: agents.overrides,
      idempotencyKey: key,
    });
    return batch.assignments.map((item) => item.agentId);
  }

  /**
   * ScheduleVisit (R-VI-01, R-VI-02, R-DM-05) : visite planifiée sur des frais payés (ou gratuite),
   * puis agents affectés avec les contrôles de 9.4. Affectation refusée : la visite planifiée est
   * retirée et la demande revient « visite à planifier », l'erreur de la planification est rendue.
   * Sans agent (planification automatique), la visite attend son affectation.
   */
  async schedule(
    input: {
      requestId: string;
      idempotencyKey: string;
      scheduledAt: string;
      durationMinutes?: number | undefined;
    } & AgentsInput,
  ) {
    requireStaff();
    const record0 = await staffCase(this.deps, input.requestId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    const start = instant(input.scheduledAt, 'scheduledAt');
    const agentIds = input.agentIds.map((id, index) => requireUuid(id, `agentIds[${index}]`));
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'visit.schedule',
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      at: now,
      replay: async (response) => (await caseOfVisit(this.deps, String(response.visitId))).record,
      run: async (stub) => {
        const record = await staffCase(this.deps, input.requestId);
        const settings = await this.deps.caseSettings.caseSettings();
        const duration = input.durationMinutes ?? settings.visitDurationMinutes;
        if (!Number.isInteger(duration) || duration < 15 || duration > 600) {
          throw cleaningErrors.invalid('durationMinutes', 'out_of_range');
        }
        const planned = decide(() =>
          planVisit({
            id: this.deps.ids.next(),
            attempt: record.visits.reduce((max, visit) => Math.max(max, visit.attempt), 0) + 1,
            requestStatus: effectiveStatus(record, now),
            fees: record.fees,
            start,
            durationMinutes: duration,
            requestCreatedAt: record.request.createdAt,
            minLeadHours: settings.minVisitLeadHours,
            now,
          }),
        );
        const visit: VisitRecord = {
          ...planned.visit,
          observedValues: null,
          observationNote: null,
          observedBy: null,
          observedAt: null,
          photoFileIds: [],
          arrivalGpsEncrypted: null,
          arrivalDistanceM: null,
          changeReason: null,
          createdBy: staffId,
          createdAt: now,
        };
        const next = withVisit(
          { ...record, request: { ...record.request, status: planned.requestStatus, updatedAt: now } },
          visit,
        );
        let saved = await saveCase(this.deps, next, record.request.version, {
          changes: { events: [], audit: [] },
        });
        let assigned: string[];
        try {
          assigned = await this.assign(visit.id, { ...input, agentIds }, `${input.idempotencyKey}:assign`);
        } catch (error) {
          await saveCase(this.deps, record, saved.request.version, {
            changes: { events: [], audit: [] },
            removedVisitIds: [visit.id],
          });
          throw error;
        }
        saved = await saveCase(this.deps, saved, saved.request.version, {
          changes: {
            events: [await scheduledEvent(this.deps, record, visit, assigned, null, [])],
            audit: [
              audit(staffId, 'visit.scheduled', 'visit', visit.id, now, {
                requestId: record.request.id,
                agentIds: assigned,
              }),
            ],
            idempotency: stub({ visitId: visit.id }),
          },
        });
        return saved;
      },
    });
  }

  /** UpdateVisit : déplacer et/ou changer d'agents ; mêmes bornes qu'à la planification. */
  async update(input: {
    visitId: string;
    idempotencyKey: string;
    scheduledAt?: string | undefined;
    durationMinutes?: number | undefined;
    agentIds?: string[] | undefined;
    leadAgentId?: string | undefined;
    overrides?: { check: string; reason: string }[] | undefined;
    reason?: string | undefined;
  }) {
    requireStaff();
    const { record: record0 } = await caseOfVisit(this.deps, input.visitId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'visit.update',
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      at: now,
      replay: async () => (await caseOfVisit(this.deps, input.visitId)).record,
      run: async (stub) => {
        const { record, visit } = await caseOfVisit(this.deps, input.visitId);
        const settings = await this.deps.caseSettings.caseSettings();
        const start = input.scheduledAt ? instant(input.scheduledAt, 'scheduledAt') : visit.scheduledStart;
        const moved = decide(() =>
          moveVisit(visit, start, record.request.createdAt, now, settings.minVisitLeadHours),
        );
        const next: VisitRecord = {
          ...visit,
          ...moved,
          durationMinutes: input.durationMinutes ?? visit.durationMinutes,
          changeReason: input.reason?.trim() || visit.changeReason,
        };
        const current = await visitAgents(this.deps, visit.id, now);
        const wanted = input.agentIds ?? current;
        const changed =
          start.getTime() !== visit.scheduledStart.getTime() ||
          next.durationMinutes !== visit.durationMinutes;
        let saved = await saveCase(this.deps, withVisit(record, next), record.request.version, {
          changes: { events: [], audit: [] },
        });
        let released: string[] = [];
        let assigned = current;
        if (changed || input.agentIds) {
          released = await releaseVisitAgents(this.deps, visit.id, {
            by: staffId,
            reason: input.reason?.trim() || 'visit_updated',
            at: now,
          });
          assigned = await this.assign(
            visit.id,
            { agentIds: wanted, leadAgentId: input.leadAgentId ?? null, overrides: input.overrides ?? [] },
            `${input.idempotencyKey}:assign`,
          );
        }
        saved = await saveCase(this.deps, saved, saved.request.version, {
          changes: {
            events: [
              await scheduledEvent(
                this.deps,
                record,
                next,
                assigned,
                changed ? visit.scheduledStart : null,
                released.filter((id) => !assigned.includes(id)),
              ),
            ],
            audit: [audit(staffId, 'visit.updated', 'visit', visit.id, now, { agentIds: assigned })],
            idempotency: stub({ visitId: visit.id }),
          },
        });
        return saved;
      },
    });
  }

  /** CancelVisit (R-FV-06, RV-49) : KSP ou agent absent, frais remboursés, visite suivante gratuite. */
  async cancel(input: { visitId: string; idempotencyKey: string; cause: string; reason: string }) {
    requireStaff();
    const { record: record0 } = await caseOfVisit(this.deps, input.visitId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    if (input.cause !== 'ksp' && input.cause !== 'agent_no_show')
      throw cleaningErrors.invalid('cause', 'invalid_type');
    const cause = input.cause;
    const reason = requiredReason(input.reason);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'visit.cancel',
      key: input.idempotencyKey,
      body: { visitId: input.visitId, cause, reason },
      at: now,
      replay: async () => (await caseOfVisit(this.deps, input.visitId)).record,
      run: async (stub) => {
        const { record, visit } = await caseOfVisit(this.deps, input.visitId);
        const outcome = decide(() =>
          cancelVisitByKsp({
            visit,
            cause,
            requestStatus: effectiveStatus(record, now),
            fees: record.fees,
            now,
          }),
        );
        const next = withVisit(
          {
            ...record,
            request: { ...record.request, status: outcome.requestStatus, updatedAt: now },
            fees: outcome.fees,
          },
          { ...visit, ...outcome.visit, changeReason: reason },
        );
        const refunds = await refundsFor(this.deps, record, record.fees, outcome.fees, staffId, now);
        const released = await releaseVisitAgents(this.deps, visit.id, { by: staffId, reason, at: now });
        const saved = await saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              visitCancelledEvent(
                record,
                visit.id,
                visit.scheduledStart,
                cause,
                released,
                outcome.refunded,
                now,
              ),
            ],
            audit: [
              audit(staffId, 'visit.cancelled', 'visit', visit.id, now, {
                cause,
                refunded: outcome.refunded,
              }),
            ],
            idempotency: stub({ visitId: visit.id }),
          },
          walletOperations: refunds,
        });
        await sendRefunds(this.deps, refunds, now);
        return saved;
      },
    });
  }

  /** RequestNewVisit (R-VI-07, RV-50) : devis envoyé retiré, demande à replanifier, visite gratuite. */
  async requestNewVisit(input: { requestId: string; idempotencyKey: string; reason: string }) {
    requireStaff();
    const record0 = await staffCase(this.deps, input.requestId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    const reason = requiredReason(input.reason);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'request.new_visit',
      key: input.idempotencyKey,
      body: { requestId: input.requestId, reason },
      at: now,
      replay: async () => staffCase(this.deps, input.requestId),
      run: async (stub) => {
        const record = await staffCase(this.deps, input.requestId);
        const outcome = decide(() =>
          requestNewVisit({
            request: timelineOf(record),
            sentQuote: sentQuote(record),
            reason,
            staffId,
            now,
          }),
        );
        const withdrawn = outcome.withdrawn;
        const next: CaseRecord = {
          ...record,
          request: { ...record.request, status: outcome.requestStatus, updatedAt: now },
          quotes: record.quotes.map((quote): QuoteRecord =>
            withdrawn && quote.id === withdrawn.id ? { ...quote, ...withdrawn } : quote,
          ),
        };
        const events: OutboxMessage[] = withdrawn
          ? [
              {
                type: 'cleaning.quote.withdrawn',
                payload: {
                  ...caseParty(record.request),
                  quoteId: withdrawn.id,
                  version: withdrawn.version,
                  withdrawnAt: iso(now),
                },
              },
            ]
          : [];
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events,
            audit: [
              audit(
                staffId,
                'request.new_visit_requested',
                'request',
                record.request.id,
                now,
                withdrawn ? { quoteId: withdrawn.id } : undefined,
              ),
            ],
            idempotency: stub({ requestId: record.request.id }),
          },
        });
      },
    });
  }

  /** CompleteVisitOnBehalf (R-VI-08) : clôture pour l'agent, motif, heure réelle ; constat saisi. */
  async completeOnBehalf(input: {
    visitId: string;
    idempotencyKey: string;
    reason: string;
    arrivedAt?: string | undefined;
    completedAt: string;
    values: Record<string, ParameterValue>;
    photoFileIds: string[];
  }) {
    requireStaff();
    const { record: record0 } = await caseOfVisit(this.deps, input.visitId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    const completedAt = instant(input.completedAt, 'completedAt');
    const arrivedAt = optionalInstant(input.arrivedAt, 'arrivedAt');
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'visit.complete_on_behalf',
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      at: now,
      replay: async () => (await caseOfVisit(this.deps, input.visitId)).record,
      run: async (stub) => {
        const { record, visit } = await caseOfVisit(this.deps, input.visitId);
        const hasValues = Object.keys(input.values).length > 0;
        if (!hasValues && !visit.observedValues) throw cleaningErrors.invalid('values', 'required');
        const done = decide(() =>
          completeVisitOnBehalf(visit, { staffId, reason: input.reason, completedAt, now }),
        );
        const photos = await this.attachPhotos(visit, input.photoFileIds, staffId);
        const next = withVisit(
          { ...record, request: { ...record.request, status: done.requestStatus, updatedAt: now } },
          {
            ...visit,
            ...done.visit,
            arrivedAt: visit.arrivedAt ?? arrivedAt ?? completedAt,
            observedValues: hasValues ? input.values : visit.observedValues,
            observedBy: hasValues ? staffId : visit.observedBy,
            observedAt: hasValues ? completedAt : visit.observedAt,
            photoFileIds: photos,
          },
        );
        const agentIds = await visitAgents(this.deps, visit.id, now);
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              {
                type: 'cleaning.visit.completed',
                payload: {
                  ...caseParty(record.request),
                  visitId: visit.id,
                  agentIds,
                  completedAt: iso(completedAt),
                  completedBy: 'ksp',
                },
              },
            ],
            audit: [
              audit(staffId, 'visit.closed_by_ksp', 'visit', visit.id, now, { on_behalf_of: agentIds }),
            ],
            idempotency: stub({ visitId: visit.id }),
          },
        });
      },
    });
  }

  /** ReportVisitMissedOnBehalf (R-VI-08, R-VI-05) : absence du client, photo facultative. */
  async missedOnBehalf(input: {
    visitId: string;
    idempotencyKey: string;
    reason: string;
    missedAt: string;
    photoFileId?: string | undefined;
  }) {
    requireStaff();
    const { record: record0 } = await caseOfVisit(this.deps, input.visitId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    const missedAt = instant(input.missedAt, 'missedAt');
    const photo = input.photoFileId ? requireUuid(input.photoFileId, 'photoFileId') : null;
    const now = this.deps.clock.now();
    if (missedAt.getTime() > now.getTime()) throw cleaningErrors.invalid('missedAt', 'in_future');
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'visit.missed_on_behalf',
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      at: now,
      replay: async () => (await caseOfVisit(this.deps, input.visitId)).record,
      run: async (stub) =>
        reportMissed(this.deps, {
          visitId: input.visitId,
          photoFileId: photo,
          staff: { id: staffId, reason: input.reason },
          actorId: staffId,
          missedAt,
          now,
          idempotency: stub,
        }),
    });
  }

  /** RemoveVisitPhotoAsKsp (R-EX-10, RV-72) : à tout moment, motif ; suppression chez file d'abord. */
  async removePhotoAsKsp(input: { visitId: string; fileId: string; idempotencyKey: string; reason: string }) {
    requireStaff();
    const { record: record0 } = await caseOfVisit(this.deps, input.visitId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    const fileId = requireUuid(input.fileId, 'fileId');
    const reason = requiredReason(input.reason);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'visit.photo.remove_as_ksp',
      key: input.idempotencyKey,
      body: { visitId: input.visitId, fileId, reason },
      at: now,
      replay: async () => (await caseOfVisit(this.deps, input.visitId)).record,
      run: async (stub) =>
        removeVisitPhoto(this.deps, input.visitId, fileId, staffId, now, stub({ visitId: input.visitId })),
    });
  }

  private async attachPhotos(
    visit: VisitRecord,
    fileIds: readonly string[],
    ownerId: string,
  ): Promise<string[]> {
    const photos = [...visit.photoFileIds];
    for (const [index, raw] of fileIds.entries()) {
      const fileId = requireUuid(raw, `photoFileIds[${index}]`);
      if (photos.includes(fileId)) continue;
      decide(() => assertVisitPhotoLimit(photos.length));
      await this.deps.photos.attach({ fileId, subject: { type: 'cleaning_visit', id: visit.id }, ownerId });
      photos.push(fileId);
    }
    return photos;
  }
}

/**
 * R-VI-05 : client absent (agent ou back-office). Visite « manquée », frais conservés, nouveaux frais
 * au montant du jour et demande « frais à payer », agents libérés — dans la même transaction pour le
 * dossier. Commun à l'agent et au back-office.
 */
export async function reportMissed(
  deps: CleaningDeps,
  input: {
    visitId: string;
    photoFileId: string | null;
    staff: { id: string; reason: string } | null;
    actorId: string;
    missedAt: Date;
    now: Date;
    idempotency: (response: Record<string, unknown>) => IdempotencyRecord;
  },
): Promise<CaseRecord> {
  const { record, visit } = await caseOfVisit(deps, input.visitId);
  const settings = await deps.caseSettings.caseSettings();
  const amount = await visitFeeOfDay(deps, record);
  const outcome = decide(() =>
    reportClientAbsent({
      visit,
      requestStatus: effectiveStatus(record, input.now),
      fees: record.fees,
      newFee: { id: deps.ids.next(), amount },
      paymentHours: settings.visitFeePaymentHours,
      photoFileId: input.photoFileId,
      staff: input.staff,
      now: input.now,
    }),
  );
  if (input.missedAt.getTime() < visit.scheduledStart.getTime()) {
    throw cleaningErrors.invalid('missedAt', 'out_of_range');
  }
  if (input.photoFileId) {
    await deps.photos.attach({
      fileId: input.photoFileId,
      subject: { type: 'cleaning_visit', id: visit.id },
      ownerId: input.actorId,
    });
  }
  const fresh = outcome.fees.at(-1)!;
  const next = withVisit(
    {
      ...record,
      request: { ...record.request, status: outcome.requestStatus, updatedAt: input.now },
      fees: outcome.fees,
    },
    { ...visit, ...outcome.visit, missedAt: input.missedAt },
  );
  await releaseVisitAgents(deps, visit.id, {
    by: input.staff?.id ?? null,
    reason: 'customer_absent',
    at: input.now,
  });
  return saveCase(deps, next, record.request.version, {
    changes: {
      events: [
        {
          type: 'cleaning.visit.missed',
          payload: {
            ...caseParty(record.request),
            visitId: visit.id,
            missedAt: iso(input.missedAt),
            communeKey: record.request.communeKey,
            reportedBy: input.staff ? 'ksp' : 'agent',
            newVisitFee: money(fresh.amount),
            newVisitFeePayBefore: iso(fresh.dueAt as Date),
          },
        },
      ],
      audit: [
        audit(
          input.actorId,
          input.staff ? 'visit.missed_by_ksp' : 'visit.missed',
          'visit',
          visit.id,
          input.now,
          {
            newVisitFeeId: fresh.id,
            amount: fresh.amount,
          },
        ),
      ],
      idempotency: input.idempotency({ visitId: visit.id }),
    },
  });
}

/** Retrait d'une photo de visite (RV-72) : chez file d'abord (idempotent), puis la référence. */
export async function removeVisitPhoto(
  deps: CleaningDeps,
  visitId: string,
  fileId: string,
  actorId: string,
  now: Date,
  idempotency: IdempotencyRecord,
): Promise<CaseRecord> {
  const { record, visit } = await caseOfVisit(deps, visitId);
  if (visit.photoFileIds.includes(fileId) || visit.missedPhotoFileId === fileId) {
    await deps.photos.remove(fileId, { type: 'cleaning_visit', id: visit.id });
  }
  const next = withVisit(record, {
    ...visit,
    photoFileIds: visit.photoFileIds.filter((id) => id !== fileId),
    missedPhotoFileId: visit.missedPhotoFileId === fileId ? null : visit.missedPhotoFileId,
  });
  return saveCase(deps, next, record.request.version, {
    changes: {
      events: [],
      audit: [audit(actorId, 'visit.photo_removed', 'visit', visit.id, now, { fileId })],
      idempotency,
    },
  });
}
