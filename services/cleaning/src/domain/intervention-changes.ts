import { type Intervention } from './mission';

/**
 * Compléments d'un passage (ADR-053) : photos avant et après, report, annulation pour replanifier.
 * Les photos sont des références du service file : aucun fichier n'est stocké dans cleaning.
 */
export type PhotoKind = 'before' | 'after';
export const PHOTO_KINDS: readonly PhotoKind[] = ['before', 'after'];

const PHOTO_FIELDS = {
  before: 'beforePhotoFileIds',
  after: 'afterPhotoFileIds',
} as const satisfies Record<PhotoKind, keyof Intervention>;

/** Photos ajoutées ou retirées tant que le passage n'est ni terminé ni annulé. */
export function canEditPhotos(intervention: Pick<Intervention, 'status'>): boolean {
  return intervention.status !== 'completed' && intervention.status !== 'cancelled';
}

export function photoIds(intervention: Intervention, kind: PhotoKind): string[] {
  return intervention[PHOTO_FIELDS[kind]];
}

/** Type de la photo si le fichier est déjà rattaché au passage, null sinon. */
export function photoKindOf(intervention: Intervention, fileId: string): PhotoKind | null {
  return PHOTO_KINDS.find((kind) => photoIds(intervention, kind).includes(fileId)) ?? null;
}

/** Photo ajoutée à la fin de son type ; sans effet si le fichier y est déjà. */
export function withPhoto(intervention: Intervention, kind: PhotoKind, fileId: string): Intervention {
  if (photoIds(intervention, kind).includes(fileId)) return intervention;
  return { ...intervention, [PHOTO_FIELDS[kind]]: [...photoIds(intervention, kind), fileId] };
}

export function withoutPhoto(intervention: Intervention, fileId: string): Intervention {
  return {
    ...intervention,
    beforePhotoFileIds: intervention.beforePhotoFileIds.filter((id) => id !== fileId),
    afterPhotoFileIds: intervention.afterPhotoFileIds.filter((id) => id !== fileId),
  };
}

/** Seul un passage planifié (pas encore commencé) se reporte ou s'annule pour être replanifié. */
export function canChangeSchedule(intervention: Pick<Intervention, 'status'>): boolean {
  return intervention.status === 'planned';
}

/** Passage reporté : nouveau début, durée et agents, motif gardé ; il reste planifié. */
export function rescheduledIntervention(
  intervention: Intervention,
  change: { start: Date; durationMinutes: number; agentIds: string[]; reason: string },
): Intervention {
  return {
    ...intervention,
    scheduledStart: change.start,
    durationMinutes: change.durationMinutes,
    agentIds: change.agentIds,
    changeReason: change.reason,
  };
}

/**
 * Passage annulé pour être replanifié : la mission retrouve un passage à planifier, le nombre de
 * passages prévus (donc l'argent) ne change pas.
 */
export function unscheduledIntervention(intervention: Intervention, reason: string, now: Date): Intervention {
  return {
    ...intervention,
    status: 'cancelled',
    cancellationCause: 'unscheduled',
    cancelledAt: now,
    changeReason: reason,
  };
}

/** Agents du passage d'avant qui n'y sont plus. */
export function releasedAgents(
  before: Pick<Intervention, 'agentIds'>,
  after: Pick<Intervention, 'agentIds'>,
) {
  return [...new Set(before.agentIds)].filter((agentId) => !after.agentIds.includes(agentId));
}
