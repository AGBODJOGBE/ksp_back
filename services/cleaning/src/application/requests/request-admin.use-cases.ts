import { permissionZones, requireUser } from '@ksp/platform';
import {
  assertLocationCorrection,
  decideReactivation,
  rejectRequest,
} from '../../domain/requests/request-lifecycle';
import { REQUEST_STATUSES, type RequestStatus } from '../../domain/requests/request-status';
import { type CleaningDeps } from '../deps';
import { requireConnectedUser, requireStaff } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { page as parsePage, requiredReason, text } from '../shared/input';
import { caseErrors, decide } from './case-errors';
import { audit, caseParty, iso, liveVisit, saveCase, staffCase, timelineOf } from './case-support';
import { ClientRequestsUseCases } from './client-requests.use-cases';
import { decryptLocation, encryptLocation, parseAccuracy, parsePoint, requireCommune } from './locations';
import { type CaseFilter, type CaseRecord, type PlaceRecord } from './requests.ports';
import { CASE_PERMISSIONS, staffWith } from './staff';
import { visitAgents } from './visit-agenda';

/** Issue d'une correction de position (contrat LocationCorrection). */
export interface LocationCorrected {
  record: CaseRecord;
  communeChanged: boolean;
  placeUpdated: boolean;
  correctedAt: Date;
}

/** UC-NT-30, UC-NT-33 — Dossiers au back-office : liste, fiche, refus, position, réactivation. */
export class RequestAdminUseCases {
  private readonly closing: ClientRequestsUseCases;

  constructor(private readonly deps: CleaningDeps) {
    this.closing = new ClientRequestsUseCases(deps);
  }

  /** Liste filtrée par la portée « zone » de l'appelant (R-RB-03). */
  async list(input: {
    status?: string | undefined;
    communeKey?: string | undefined;
    q?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }) {
    staffWith(CASE_PERMISSIONS.read);
    if (input.status && !(REQUEST_STATUSES as readonly string[]).includes(input.status)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    const filter: CaseFilter = {
      zones: permissionZones(requireUser(), CASE_PERMISSIONS.read),
      ...(input.status ? { statuses: [input.status as RequestStatus] } : {}),
      ...(input.communeKey ? { communeKey: input.communeKey } : {}),
      ...(input.q ? { search: input.q.trim() } : {}),
    };
    // Jeton sans permissions (voir staffWith) : toutes les zones.
    if (requireUser().permissions === undefined) filter.zones = 'all';
    return this.deps.cases.listCases(filter, parsePage(input.limit, input.cursor));
  }

  async get(requestId: string): Promise<CaseRecord> {
    requireStaff();
    const record = await staffCase(this.deps, requestId);
    staffWith(CASE_PERMISSIONS.read, record.request.communeKey);
    return record;
  }

  /** R-AC-05 : refus à toute étape avant l'acceptation ; frais remboursés sans visite (R-FV-06). */
  async reject(input: { requestId: string; idempotencyKey: string; reasonCode: string; reason: string }) {
    requireStaff();
    const record0 = await staffCase(this.deps, input.requestId);
    const staffId = staffWith(CASE_PERMISSIONS.process, record0.request.communeKey);
    const reason = requiredReason(input.reason);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'request.reject',
      key: input.idempotencyKey,
      body: { requestId: input.requestId, reasonCode: input.reasonCode, reason },
      at: now,
      replay: async () => staffCase(this.deps, input.requestId),
      run: async (stub) => {
        const record = await staffCase(this.deps, input.requestId);
        const outcome = decide(() =>
          rejectRequest({
            request: timelineOf(record),
            fees: record.fees,
            visits: record.visits,
            reasonCode: input.reasonCode,
            reason,
            now,
          }),
        );
        return this.closing.close(record, staffId, {
          status: 'rejected',
          fees: outcome.fees,
          refunded: outcome.refunded,
          visitCause: outcome.visitCancelCause,
          reasonCode: outcome.reasonCode,
          reason: outcome.reason,
          visit: liveVisit(record),
          event: (refund) => ({
            type: 'cleaning.request.rejected',
            payload: {
              ...caseParty(record.request),
              reasonCode: outcome.reasonCode as 'place_inaccessible' | 'service_impossible' | 'other',
              rejectedBy: staffId,
              visitFeeRefund: refund,
              rejectedAt: iso(now),
            },
          }),
          stub: stub({ requestId: record.request.id }),
          now,
        });
      },
    });
  }

  /**
   * R-DM-07, R-DM-08, RV-38 : correction de la position, motif obligatoire. Supervision
   * (cleaning.request.process) ou agent affecté à la visite en cours (cleaning.visit.perform). La
   * copie du dossier est corrigée, et le lieu de « Mes lieux » s'il n'a pas changé depuis l'envoi,
   * dans la même transaction. Tracée sans coordonnées ni repère.
   */
  async correctLocation(input: {
    requestId: string;
    idempotencyKey: string;
    latitude: number;
    longitude: number;
    accuracyMeters?: number | undefined;
    landmark?: string | undefined;
    address?: string | undefined;
    reason: string;
  }): Promise<LocationCorrected> {
    requireConnectedUser();
    const record0 = await staffCase(this.deps, input.requestId);
    const actor = await this.correctionActor(record0);
    const point = parsePoint(input.latitude, input.longitude);
    if (!point) throw cleaningErrors.invalid('latitude', 'required');
    const accuracyM = parseAccuracy(input.accuracyMeters);
    const reason = requiredReason(input.reason);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: actor.id,
      operation: 'request.location.correct',
      key: input.idempotencyKey,
      body: {
        requestId: input.requestId,
        point,
        accuracyM,
        landmark: input.landmark ?? null,
        address: input.address ?? null,
        reason,
      },
      at: now,
      replay: async (response) => ({
        record: await staffCase(this.deps, input.requestId),
        communeChanged: response.communeChanged === true,
        placeUpdated: response.placeUpdated === true,
        correctedAt: new Date(String(response.correctedAt)),
      }),
      run: async (stub) => {
        const record = await staffCase(this.deps, input.requestId);
        const resolved = requireCommune(await this.deps.communeResolver.resolve(point));
        const zone = await this.deps.zones.findByCommune(resolved.commune.key);
        if (!zone?.active) throw caseErrors.zoneNotCovered('commune_not_served', resolved.commune);
        const communeChanged = resolved.commune.key !== record.request.communeKey;
        decide(() =>
          assertLocationCorrection(
            {
              request: timelineOf(record),
              communeChanged,
              program: record.programStatus ? { status: record.programStatus } : null,
            },
            now,
          ),
        );
        const before = decryptLocation(this.deps.cipher, 'request', record.request.id, record.request);
        const landmark =
          input.landmark !== undefined ? text(input.landmark, 'landmark') : (before?.landmark ?? null);
        const address =
          input.address !== undefined ? text(input.address, 'address') : (before?.address ?? null);
        const readableAddress = (await this.deps.geocoder.reverse(point))?.displayAddress ?? null;
        const location = { ...point, accuracyM, landmark, address, readableAddress };
        const next: CaseRecord = {
          ...record,
          request: {
            ...record.request,
            ...encryptLocation(this.deps.cipher, 'request', record.request.id, location, resolved),
            updatedAt: now,
          },
        };
        const place = await this.placeToCorrect(record, before, location, resolved, actor.id, now);
        const saved = await saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [],
            audit: [
              audit(actor.id, 'request.location_corrected', 'request', record.request.id, now, {
                requestId: record.request.id,
                programId: record.programId,
                communeChanged,
                byAgent: actor.byAgent,
                placeUpdated: place !== null,
              }),
            ],
            idempotency: stub({
              requestId: record.request.id,
              communeChanged,
              placeUpdated: place !== null,
              correctedAt: now.toISOString(),
            }),
          },
          ...(place ? { place } : {}),
        });
        return { record: saved, communeChanged, placeUpdated: place !== null, correctedAt: now };
      },
    });
  }

  /** Le lieu n'est corrigé que si sa position est encore celle de la copie du dossier (RV-38). */
  private async placeToCorrect(
    record: CaseRecord,
    before: ReturnType<typeof decryptLocation>,
    location: Parameters<typeof encryptLocation>[3],
    resolved: Parameters<typeof encryptLocation>[4],
    actorId: string,
    now: Date,
  ): Promise<{ record: PlaceRecord; expectedVersion: number } | null> {
    const place = await this.deps.clientPlaces.findPlace(record.request.placeId);
    if (!place || !before) return null;
    const current = decryptLocation(this.deps.cipher, 'place', place.id, place);
    if (!current || current.latitude !== before.latitude || current.longitude !== before.longitude)
      return null;
    return {
      record: {
        ...place,
        ...encryptLocation(this.deps.cipher, 'place', place.id, location, resolved),
        locationCorrectedAt: now,
        locationCorrectedBy: actorId,
        updatedAt: now,
      },
      expectedVersion: place.version,
    };
  }

  /** Supervision, ou agent affecté à la visite en cours ; sinon le dossier est introuvable. */
  private async correctionActor(record: CaseRecord): Promise<{ id: string; byAgent: boolean }> {
    const user = requireUser();
    const can = (permission: string) =>
      user.permissions === undefined ||
      user.permissions.includes(permission) ||
      (user.zonePermissions?.[record.request.communeKey]?.includes(permission) ?? false);
    if (can(CASE_PERMISSIONS.process) && user.mfa) {
      return { id: staffWith(CASE_PERMISSIONS.process, record.request.communeKey), byAgent: false };
    }
    if (can(CASE_PERMISSIONS.visitPerform)) {
      const agent = await this.deps.planning.agentByUserId(user.userId);
      const visit = record.visits.find((item) => item.status === 'in_progress');
      if (
        agent &&
        visit &&
        (await visitAgents(this.deps, visit.id, this.deps.clock.now())).includes(agent.id)
      ) {
        return { id: user.userId, byAgent: true };
      }
    }
    throw caseErrors.requestNotFound();
  }

  /**
   * R-AC-04 : accepter (dossier « visite faite », nouveau devis aux tarifs du jour, frais de visite
   * de nouveau déductibles) ou refuser la réactivation.
   */
  async decideReactivation(input: {
    requestId: string;
    idempotencyKey: string;
    decision: string;
    reason?: string | undefined;
  }) {
    requireStaff();
    const record0 = await staffCase(this.deps, input.requestId);
    const staffId = staffWith(CASE_PERMISSIONS.quoteManage, record0.request.communeKey);
    if (input.decision !== 'accept' && input.decision !== 'refuse')
      throw cleaningErrors.invalid('decision', 'invalid_type');
    const decision = input.decision;
    const reason = text(input.reason, 'reason');
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'request.reactivation.decide',
      key: input.idempotencyKey,
      body: { requestId: input.requestId, decision, reason },
      at: now,
      replay: async () => staffCase(this.deps, input.requestId),
      run: async (stub) => {
        const record = await staffCase(this.deps, input.requestId);
        const pending = record.reactivations.find((item) => item.status === 'pending') ?? null;
        const decided = decide(() =>
          decideReactivation(timelineOf(record), pending, decision, staffId, now, record.fees),
        );
        const next: CaseRecord = {
          ...record,
          request: {
            ...record.request,
            status: decided.requestStatus,
            closedAt: decision === 'accept' ? null : record.request.closedAt,
            updatedAt: now,
          },
          fees: decided.fees,
          reactivations: record.reactivations.map((item) =>
            pending && item.id === pending.id ? { ...item, ...decided.reactivation, reason } : item,
          ),
        };
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [],
            audit: [
              audit(
                staffId,
                `request.reactivation_${decision === 'accept' ? 'accepted' : 'refused'}`,
                'request',
                record.request.id,
                now,
                {
                  deductible: decided.fees
                    .filter((fee) => fee.status === 'paid')
                    .reduce((sum, fee) => sum + fee.amount, 0),
                },
              ),
            ],
            idempotency: stub({ requestId: record.request.id }),
          },
        });
      },
    });
  }
}
