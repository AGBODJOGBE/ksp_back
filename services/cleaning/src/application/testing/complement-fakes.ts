import { AppError } from '@ksp/platform';
import { type Assignment, visitSlot } from '../../domain/agenda';
import { ACTIVE_INTERVENTION_STATUSES, type Mission } from '../../domain/mission';
import { isOpenRequest, type QuoteRequest } from '../../domain/quote-request';
import { type BusyPeriod, slotFrom } from '../../domain/schedule';
import { type InterventionPhotoStore, type StoredPhoto } from '../ports';

/** Doublures des compléments du Nettoyage (ADR-053). */

/** Visites planifiées des demandes ouvertes, vues comme des périodes occupées. */
export function visitBusyPeriods(
  requests: Iterable<QuoteRequest>,
  visitDurationMinutes: number,
  now: Date,
  excludedVisitIds: readonly string[] = [],
): BusyPeriod[] {
  return [...requests].flatMap((request) =>
    request.visit?.status === 'scheduled' &&
    isOpenRequest(request, now) &&
    !excludedVisitIds.includes(request.visit.id)
      ? [
          {
            agentId: request.visit.agentId,
            slot: visitSlot(request.visit.scheduledAt, visitDurationMinutes),
            groupId: request.groupId,
          },
        ]
      : [],
  );
}

/** Passages actifs et visites planifiées (demande ouverte) d'un agent. */
export function agentAssignments(
  agentId: string,
  missions: Iterable<Mission>,
  requests: Iterable<QuoteRequest>,
  visitDurationMinutes: number,
  now: Date,
): Assignment[] {
  const passages = [...missions].flatMap((mission) =>
    mission.interventions
      .filter((i) => ACTIVE_INTERVENTION_STATUSES.includes(i.status) && i.agentIds.includes(agentId))
      .map((i): Assignment => ({
        kind: 'intervention',
        id: i.id,
        missionId: mission.id,
        requestId: null,
        slot: slotFrom(i.scheduledStart, i.durationMinutes),
      })),
  );
  const visits = [...requests].flatMap((request): Assignment[] =>
    request.visit?.status === 'scheduled' && request.visit.agentId === agentId && isOpenRequest(request, now)
      ? [
          {
            kind: 'visit',
            id: request.visit.id,
            missionId: null,
            requestId: request.id,
            slot: visitSlot(request.visit.scheduledAt, visitDurationMinutes),
          },
        ]
      : [],
  );
  return [...passages, ...visits];
}

/**
 * Service file simulé : fichiers disponibles par propriétaire, rattachement à un seul passage
 * (idempotent), suppression idempotente ; erreurs comme file.
 */
export class FakePhotoStore implements InterventionPhotoStore {
  readonly files = new Map<string, { ownerId: string; subjectId: string | null; deleted: boolean }>();
  readonly calls: string[] = [];

  /** Fichier envoyé par ce compte, disponible, pas encore rattaché. */
  upload(fileId: string, ownerId: string): void {
    this.files.set(fileId, { ownerId, subjectId: null, deleted: false });
  }

  async attach(input: { fileId: string; interventionId: string; ownerId: string }): Promise<void> {
    this.calls.push(`attach:${input.fileId}`);
    const file = this.files.get(input.fileId);
    if (!file || file.deleted) throw AppError.notFound('FILE_NOT_FOUND', 'Fichier introuvable.');
    if (file.ownerId !== input.ownerId) {
      throw AppError.forbidden('FILE_OWNER_MISMATCH', 'Ce fichier a été envoyé par un autre compte.');
    }
    if (file.subjectId && file.subjectId !== input.interventionId) {
      throw AppError.conflict('FILE_ALREADY_ATTACHED', 'Ce fichier est déjà rattaché à un autre objet.');
    }
    file.subjectId = input.interventionId;
  }

  async remove(fileId: string, interventionId: string): Promise<void> {
    this.calls.push(`remove:${fileId}`);
    const file = this.files.get(fileId);
    if (file && file.subjectId === interventionId) file.deleted = true;
  }

  async list(interventionId: string): Promise<StoredPhoto[]> {
    this.calls.push(`list:${interventionId}`);
    return [...this.files]
      .filter(([, file]) => file.subjectId === interventionId && !file.deleted)
      .map(([fileId]) => ({
        fileId,
        fileName: `${fileId}.jpg`,
        contentType: 'image/jpeg',
        sizeBytes: 1000,
        uploadedAt: new Date('2026-11-10T08:00:00Z'),
        downloadUrl: `https://files.ksp.bj/${fileId}`,
        downloadExpiresAt: new Date('2026-11-10T08:05:00Z'),
      }));
  }
}
