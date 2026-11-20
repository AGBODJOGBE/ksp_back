import { type ArrivalGeoCheck } from '../../domain/sessions/arrival';
import { type ChecklistPoint } from '../../domain/sessions/session';
import { type ExecutionDeps } from '../deps';
import { type GeoPoint, type StoredPhoto } from '../ports';
import { type ExecutionSettings, type ProgramRecord, type SessionRecord } from './execution.ports';

/**
 * Vues d'une séance (client, agent, back-office) : noms lus dans identity au moment de la réponse,
 * photos par liens temporaires chez file (R-EX-07), contrôle d'arrivée relu de la position chiffrée,
 * position du lieu pour l'agent seulement pendant la séance (R-EX-06).
 */

/** Contexte de chiffrement de la position d'arrivée d'une séance (partie 16.3). */
export const arrivalGpsContext = (sessionId: string) => `session:${sessionId}:arrival_gps`;

/** Position d'arrivée chiffrée, avec le contrôle calculé à l'arrivée. */
export interface ArrivalBlob {
  position: GeoPoint & { accuracyMeters: number | null };
  check: ArrivalGeoCheck;
}

export interface PhotoView {
  fileId: string;
  kind: 'before' | 'after' | 'absence' | 'incident';
  takenAt: Date;
  url: string | null;
  urlExpiresAt: Date | null;
}

export interface SessionDetails {
  program: ProgramRecord;
  session: SessionRecord;
  /** Nom affiché de chaque compte cité (agents, client). */
  names: Map<string, string>;
  photos: PhotoView[];
  /** Contrôle d'arrivée complet ; null sans arrivée. */
  arrival: ArrivalGeoCheck | null;
  /** Liste de contrôle à jour (points communs et des types si la séance n'en a pas encore). */
  checklist: ChecklistPoint[];
  /** Position du lieu : agent affecté pendant la séance seulement (R-EX-06). */
  placeLocation: GeoPoint | null;
}

/**
 * Liste de contrôle d'une séance (R-EX-09) : points communs (réglage), puis ceux de chaque type du
 * programme. Une séance qui a déjà sa liste la garde (heures réelles comprises).
 */
export function checklistFor(
  session: Pick<SessionRecord, 'checklist'>,
  program: Pick<ProgramRecord, 'cleaningTypes'>,
  settings: Pick<ExecutionSettings, 'commonChecklist'>,
): ChecklistPoint[] {
  if (session.checklist.length > 0) return session.checklist;
  const point = (cleaningTypeCode: string | null, code: string, label: string): ChecklistPoint => ({
    cleaningTypeCode,
    code,
    label,
    checked: false,
    checkedAt: null,
  });
  return [
    ...settings.commonChecklist.map((item) => point(null, item.code, item.label)),
    ...program.cleaningTypes.flatMap((type) =>
      type.checklist.map((item) => point(type.code, item.code, item.label)),
    ),
  ];
}

/** Statuts où l'agent voit la position du lieu (R-EX-06). */
const LOCATION_VISIBLE = ['assigned', 'in_progress', 'interrupted'];

export async function sessionDetails(
  deps: ExecutionDeps,
  session: SessionRecord,
  options: { forAgent?: boolean; program?: ProgramRecord } = {},
): Promise<SessionDetails> {
  const program = options.program ?? (await deps.execution.program(session.programId));
  if (!program) throw new Error(`Programme ${session.programId} introuvable.`);
  const settings = await deps.execution.settings();
  const userIds = [...new Set([program.customerId, ...session.agentDetails.map((agent) => agent.userId)])];
  const [names, stored, points] = await Promise.all([
    deps.people.userNames(userIds),
    deps.photos.list({ type: 'cleaning_session', id: session.id }).catch((): StoredPhoto[] => []),
    options.forAgent && LOCATION_VISIBLE.includes(session.status)
      ? deps.placePoints.points([program.placeId])
      : Promise.resolve(new Map<string, GeoPoint>()),
  ]);
  return {
    program,
    session,
    names,
    photos: photoViews(session, stored),
    arrival: arrivalOf(deps, session),
    checklist: checklistFor(session, program, settings),
    placeLocation: points.get(program.placeId) ?? null,
  };
}

function photoViews(session: SessionRecord, stored: readonly StoredPhoto[]): PhotoView[] {
  const byId = new Map(stored.map((photo) => [photo.fileId, photo]));
  const view = (fileId: string, kind: PhotoView['kind']): PhotoView => {
    const photo = byId.get(fileId);
    return {
      fileId,
      kind,
      takenAt: photo?.uploadedAt ?? session.updatedAt,
      url: photo?.downloadUrl ?? null,
      urlExpiresAt: photo?.downloadExpiresAt ?? null,
    };
  };
  return [
    ...session.beforePhotoFileIds.map((id) => view(id, 'before')),
    ...session.afterPhotoFileIds.map((id) => view(id, 'after')),
    ...(session.missed?.photoFileId ? [view(session.missed.photoFileId, 'absence')] : []),
  ];
}

function arrivalOf(deps: ExecutionDeps, session: SessionRecord): ArrivalGeoCheck | null {
  if (!session.arrivedAt) return null;
  if (!session.arrivalGpsEncrypted) return session.arrival;
  try {
    const blob = JSON.parse(
      deps.cipher.decrypt(session.arrivalGpsEncrypted, arrivalGpsContext(session.id)),
    ) as ArrivalBlob;
    return blob.check;
  } catch {
    return session.arrival;
  }
}
