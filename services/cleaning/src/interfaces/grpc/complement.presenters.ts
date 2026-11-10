import { type cleaningV1 } from '@ksp/contracts';
import { type InterventionPhoto } from '../../application/missions/intervention-photos.use-cases';
import { type Assignment } from '../../domain/agenda';

/** Messages des compléments du Nettoyage (ADR-053). */
const iso = (date: Date | null) => (date ? date.toISOString() : '');

export function presentPhoto(photo: InterventionPhoto): cleaningV1.InterventionPhoto {
  return {
    fileId: photo.fileId,
    kind: photo.kind,
    fileName: photo.fileName,
    contentType: photo.contentType,
    sizeBytes: photo.sizeBytes,
    uploadedAt: iso(photo.uploadedAt),
    downloadUrl: photo.downloadUrl ?? '',
    downloadExpiresAt: iso(photo.downloadExpiresAt),
  };
}

export function presentAssignment(assignment: Assignment): cleaningV1.AgentAssignment {
  return {
    kind: assignment.kind,
    id: assignment.id,
    missionId: assignment.missionId ?? '',
    requestId: assignment.requestId ?? '',
    start: assignment.slot.start.toISOString(),
    end: assignment.slot.end.toISOString(),
  };
}
