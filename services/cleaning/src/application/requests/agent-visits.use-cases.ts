import { requirePermission, requireUser } from '@ksp/platform';
import { type ParameterValue } from '../../domain/pricing/types';
import { invalidTransition } from '../../domain/requests/errors';
import {
  assertVisitPhotoLimit,
  completeVisit,
  markArrived,
  MAX_OCCURRED_AGE_HOURS,
  observationTime,
} from '../../domain/visits/visit';
import { type CleaningDeps } from '../deps';
import { requireConnectedUser } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { optionalInstant, requireUuid } from '../shared/input';
import { caseErrors, decide, ruleAppError } from './case-errors';
import { audit, caseOfVisit, caseParty, iso, saveCase } from './case-support';
import { decryptLocation, distanceMeters, parseAccuracy, parsePoint } from './locations';
import { type CaseRecord, type VisitRecord } from './requests.ports';
import { CASE_PERMISSIONS } from './staff';
import { visitAgents } from './visit-agenda';
import { removeVisitPhoto, reportMissed, withVisit } from './visits-admin.use-cases';

/** Remarque de l'agent pour le superviseur : 1 000 caractères au plus. */
const MAX_NOTE_LENGTH = 1_000;

/** Visite vue par l'agent affecté ; position visible seulement pendant la visite en cours (R-EX-06). */
export interface AgentVisit {
  record: CaseRecord;
  visit: VisitRecord;
  agentIds: string[];
  showLocation: boolean;
}

/**
 * UC-NT-22 — Visite côté terrain (R-VI-04, R-VI-05, R-EX-05, R-EX-10) : arrivée, constat, photos,
 * clôture, client absent. Seul un agent affecté voit la visite (sinon CLEANING_VISIT_NOT_FOUND).
 * Actions rejouables hors connexion : clé d'idempotence et heure réelle `occurredAt`.
 */
export class AgentVisitsUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  /** Agent connecté, permission cleaning.visit.perform, affecté à la visite. */
  private async assigned(visitId: string): Promise<AgentVisit & { userId: string }> {
    const userId = requireConnectedUser();
    if (requireUser().permissions !== undefined) requirePermission(CASE_PERMISSIONS.visitPerform);
    const agent = await this.deps.planning.agentByUserId(userId);
    const { record, visit } = await caseOfVisit(this.deps, visitId);
    const now = this.deps.clock.now();
    const agentIds = await visitAgents(this.deps, visit.id, now);
    if (!agent || !agentIds.includes(agent.id)) throw caseErrors.visitNotFound();
    return { record, visit, agentIds, userId, showLocation: visit.status === 'in_progress' };
  }

  async get(visitId: string): Promise<AgentVisit> {
    requireConnectedUser();
    const { userId: _user, ...view } = await this.assigned(requireUuid(visitId, 'visitId'));
    return view;
  }

  /** Heure réelle d'une action gardée hors connexion (D24) : ni future, ni de plus de 72 h. */
  private occurred(value: string | undefined, now: Date): Date | null {
    const at = optionalInstant(value, 'occurredAt');
    if (!at) return null;
    if (at.getTime() > now.getTime()) throw cleaningErrors.invalid('occurredAt', 'in_future');
    if (now.getTime() - at.getTime() > MAX_OCCURRED_AGE_HOURS * 3_600_000) {
      throw cleaningErrors.invalid('occurredAt', 'too_old');
    }
    return at;
  }

  private run<T>(
    operation: string,
    input: { visitId: string; idempotencyKey: string },
    body: unknown,
    work: (
      ctx: AgentVisit & { userId: string; now: Date },
      stub: Parameters<Parameters<typeof runIdempotent>[0]['run']>[0],
    ) => Promise<T>,
    replay: () => Promise<T>,
  ): Promise<T> {
    const userId = requireConnectedUser();
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation,
      key: input.idempotencyKey,
      body,
      at: now,
      replay,
      run: async (stub) =>
        work({ ...(await this.assigned(requireUuid(input.visitId, 'visitId'))), now }, stub),
    });
  }

  /** Arrivée (R-VI-04) : position comparée à celle du dossier, alerte au-delà du réglage, sans blocage. */
  async arrive(input: {
    visitId: string;
    idempotencyKey: string;
    latitude?: number | undefined;
    longitude?: number | undefined;
    accuracyMeters?: number | undefined;
    occurredAt?: string | undefined;
  }) {
    requireConnectedUser();
    const point = parsePoint(input.latitude, input.longitude);
    const accuracyM = parseAccuracy(input.accuracyMeters);
    return this.run(
      'visit.arrive',
      input,
      { ...input, idempotencyKey: undefined },
      async ({ record, visit, userId, now }, stub) => {
        const at = this.occurred(input.occurredAt, now) ?? now;
        const arrived = decide(() => markArrived(visit, at));
        const settings = await this.deps.caseSettings.caseSettings();
        const site = decryptLocation(this.deps.cipher, 'request', record.request.id, record.request);
        const distance = point && site ? distanceMeters(point, site) : null;
        const alert = distance !== null && distance > settings.arrivalAlertMeters;
        const next = withVisit(record, {
          ...visit,
          ...arrived,
          arrivalGpsEncrypted: point
            ? this.deps.cipher.encrypt(
                JSON.stringify({ ...point, ...(accuracyM !== null ? { accuracyM } : {}) }),
                `visit:${visit.id}:arrival_gps`,
              )
            : null,
          arrivalDistanceM: distance,
        });
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              {
                type: 'cleaning.visit.arrived',
                payload: {
                  ...caseParty(record.request),
                  visitId: visit.id,
                  communeKey: record.request.communeKey,
                  distanceMeters: distance,
                  alert,
                  arrivedAt: iso(at),
                },
              },
            ],
            audit: [
              audit(userId, 'visit.arrived', 'visit', visit.id, now, { distanceMeters: distance, alert }),
            ],
            idempotency: stub({ visitId: visit.id }),
          },
        });
      },
      async () => (await caseOfVisit(this.deps, input.visitId)).record,
    );
  }

  /** Constat (7.4, R-VI-04) : à partir de l'heure prévue, remplace le précédent jusqu'à la clôture. */
  async saveObservations(input: {
    visitId: string;
    idempotencyKey: string;
    values: Record<string, ParameterValue>;
    note?: string | undefined;
    occurredAt?: string | undefined;
  }) {
    requireConnectedUser();
    const note = input.note?.trim() || null;
    if (note && note.length > MAX_NOTE_LENGTH) throw cleaningErrors.invalid('note', 'out_of_range');
    if (!Object.keys(input.values).length) throw cleaningErrors.invalid('values', 'required');
    return this.run(
      'visit.observations.save',
      input,
      { ...input, idempotencyKey: undefined },
      async ({ record, visit, userId, now }, stub) => {
        if (visit.status !== 'in_progress') throw ruleAppError(invalidTransition(visit.status, visit.status));
        const at = decide(() => observationTime(visit, now, this.occurred(input.occurredAt, now)));
        const next = withVisit(record, {
          ...visit,
          observedValues: { ...input.values },
          observationNote: note,
          observedBy: userId,
          observedAt: at,
        });
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [],
            audit: [audit(userId, 'visit.observed', 'visit', visit.id, now)],
            idempotency: stub({ visitId: visit.id }),
          },
        });
      },
      async () => (await caseOfVisit(this.deps, input.visitId)).record,
    );
  }

  /** Photo de la visite (R-VI-04) : 10 au plus, rattachée chez file au nom de l'agent. */
  async addPhoto(input: {
    visitId: string;
    idempotencyKey: string;
    fileId: string;
    occurredAt?: string | undefined;
  }) {
    requireConnectedUser();
    const fileId = requireUuid(input.fileId, 'fileId');
    return this.run(
      'visit.photo.add',
      input,
      { visitId: input.visitId, fileId },
      async ({ record, visit, userId, now }, stub) => {
        this.occurred(input.occurredAt, now);
        if (visit.status !== 'scheduled' && visit.status !== 'in_progress') {
          throw ruleAppError(invalidTransition(visit.status, visit.status));
        }
        if (!visit.photoFileIds.includes(fileId)) {
          decide(() => assertVisitPhotoLimit(visit.photoFileIds.length));
          await this.deps.photos.attach({
            fileId,
            subject: { type: 'cleaning_visit', id: visit.id },
            ownerId: userId,
          });
        }
        const next = withVisit(record, {
          ...visit,
          photoFileIds: [...new Set([...visit.photoFileIds, fileId])],
        });
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [],
            audit: [audit(userId, 'visit.photo_added', 'visit', visit.id, now, { fileId })],
            idempotency: stub({ visitId: visit.id }),
          },
        });
      },
      async () => (await caseOfVisit(this.deps, input.visitId)).record,
    );
  }

  /** Clôture (R-VI-04) : constat saisi exigé, la demande passe « visite faite ». */
  async complete(input: { visitId: string; idempotencyKey: string; occurredAt?: string | undefined }) {
    return this.run(
      'visit.complete',
      input,
      { visitId: input.visitId },
      async ({ record, visit, userId, agentIds, now }, stub) => {
        if (visit.status === 'in_progress' && !visit.observedValues) {
          throw cleaningErrors.invalid('values', 'required');
        }
        const done = decide(() => completeVisit(visit, now, this.occurred(input.occurredAt, now)));
        const next = withVisit(
          { ...record, request: { ...record.request, status: done.requestStatus, updatedAt: now } },
          { ...visit, ...done.visit },
        );
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              {
                type: 'cleaning.visit.completed',
                payload: {
                  ...caseParty(record.request),
                  visitId: visit.id,
                  agentIds,
                  completedAt: iso(done.visit.completedAt as Date),
                  completedBy: 'agent',
                },
              },
            ],
            audit: [audit(userId, 'visit.completed', 'visit', visit.id, now)],
            idempotency: stub({ visitId: visit.id }),
          },
        });
      },
      async () => (await caseOfVisit(this.deps, input.visitId)).record,
    );
  }

  /** Client absent (R-VI-05) : photo du lieu obligatoire, nouveaux frais, demande « frais à payer ». */
  async reportMissed(input: {
    visitId: string;
    idempotencyKey: string;
    photoFileId: string;
    occurredAt?: string | undefined;
  }) {
    requireConnectedUser();
    const photo = input.photoFileId ? requireUuid(input.photoFileId, 'photoFileId') : null;
    return this.run(
      'visit.missed',
      input,
      { visitId: input.visitId, photo },
      async ({ userId, now }, stub) =>
        reportMissed(this.deps, {
          visitId: input.visitId,
          photoFileId: photo,
          staff: null,
          actorId: userId,
          missedAt: this.occurred(input.occurredAt, now) ?? now,
          now,
          idempotency: stub,
        }),
      async () => (await caseOfVisit(this.deps, input.visitId)).record,
    );
  }

  /** Retrait d'une photo (R-EX-10) tant que la visite n'est ni réalisée ni annulée. */
  async removePhoto(input: { visitId: string; fileId: string; idempotencyKey: string }) {
    requireConnectedUser();
    const fileId = requireUuid(input.fileId, 'fileId');
    return this.run(
      'visit.photo.remove',
      input,
      { visitId: input.visitId, fileId },
      async ({ visit, userId, now }, stub) => {
        if (visit.status === 'completed' || visit.status === 'cancelled') {
          throw ruleAppError(invalidTransition(visit.status, visit.status));
        }
        return removeVisitPhoto(this.deps, visit.id, fileId, userId, now, stub({ visitId: visit.id }));
      },
      async () => (await caseOfVisit(this.deps, input.visitId)).record,
    );
  }
}
