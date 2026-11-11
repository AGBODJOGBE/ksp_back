import {
  canEditPhotos,
  PHOTO_KINDS,
  type PhotoKind,
  photoIds,
  photoKindOf,
  withoutPhoto,
  withPhoto,
} from '../../domain/intervention-changes';
import { type Intervention, type Mission } from '../../domain/mission';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { missionForStaff } from '../groups/group-support';
import { type StoredPhoto } from '../ports';
import {
  currentCustomer,
  FIELD_WORK,
  ownsCase,
  requireStaff,
  seesEverything,
  type Staff,
} from '../shared/access';
import { ComplementErrors } from '../shared/complement-errors';
import { CleaningErrors } from '../shared/errors';
import { oneOf, requireUuid } from '../shared/validation';
import { saveMission } from './customer-missions.use-cases';

/**
 * Photos avant et après d'un passage (ADR-053), stockées par le service file (ADR-038) : le compte
 * connecté envoie le fichier à file (adresse présignée, contrôle), puis le rattache ici au passage.
 * cleaning ne garde que les références, par type ; nombre maximal réglable par type.
 */
export interface InterventionPhoto extends StoredPhoto {
  kind: PhotoKind;
}

/** Passage visible : toute la supervision, ou l'agent affecté au passage (sinon introuvable). */
async function staffIntervention(
  deps: CleaningDeps,
  staff: Staff,
  interventionIdInput: string,
): Promise<{ mission: Mission; intervention: Intervention }> {
  const interventionId = requireUuid('interventionId', interventionIdInput);
  const mission = await deps.missions.findByInterventionId(interventionId);
  const intervention = mission?.interventions.find((item) => item.id === interventionId);
  if (
    !mission ||
    !intervention ||
    (!seesEverything(staff) && !intervention.agentIds.includes(staff.userId))
  ) {
    throw CleaningErrors.interventionNotFound();
  }
  return { mission, intervention };
}

function editable(mission: Mission, intervention: Intervention): void {
  if (mission.status === 'cancelled' || !canEditPhotos(intervention))
    throw ComplementErrors.interventionClosed();
}

function withIntervention(mission: Mission, intervention: Intervention): Mission {
  return {
    ...mission,
    interventions: mission.interventions.map((item) => (item.id === intervention.id ? intervention : item)),
  };
}

/** Photos rattachées au passage, « avant » puis « après », dans l'ordre d'ajout ; fichiers absents ignorés. */
async function photosOf(deps: CleaningDeps, intervention: Intervention): Promise<InterventionPhoto[]> {
  if (!intervention.beforePhotoFileIds.length && !intervention.afterPhotoFileIds.length) return [];
  const stored = new Map((await deps.photos.list(intervention.id)).map((file) => [file.fileId, file]));
  return PHOTO_KINDS.flatMap((kind) =>
    photoIds(intervention, kind).flatMap((fileId) => {
      const file = stored.get(fileId);
      return file ? [{ ...file, kind }] : [];
    }),
  );
}

export class AddInterventionPhotoUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { interventionId: string; fileId: string; kind: string }): Promise<MissionView> {
    const staff = requireStaff(FIELD_WORK);
    const kind = oneOf('kind', input.kind, PHOTO_KINDS);
    const fileId = requireUuid('fileId', input.fileId);
    const { mission, intervention } = await staffIntervention(this.deps, staff, input.interventionId);
    editable(mission, intervention);
    const current = photoKindOf(intervention, fileId);
    if (current === kind) return missionForStaff(staff, await missionView(this.deps, mission));
    if (current)
      throw CleaningErrors.invalid('kind', 'Cette photo est déjà rattachée à ce passage avec l’autre type.');
    const { maxInterventionPhotos } = await this.deps.catalog.getSettings();
    if (photoIds(intervention, kind).length >= maxInterventionPhotos) {
      throw ComplementErrors.photoLimitReached(kind, maxInterventionPhotos);
    }
    // Rattachement chez file d'abord (idempotent) : un fichier d'un autre compte ou d'une autre
    // finalité est refusé par file, et un nouvel essai après une écriture concurrente reste possible.
    await this.deps.photos.attach({ fileId, interventionId: intervention.id, ownerId: staff.userId });
    const view = await saveMission(
      this.deps,
      withIntervention(mission, withPhoto(intervention, kind, fileId)),
      {
        events: [],
        audit: [
          {
            actorId: staff.userId,
            action: 'intervention.photo_added',
            entityType: 'mission',
            entityId: mission.id,
            at: this.deps.clock.now(),
            details: { interventionId: intervention.id, fileId, kind },
          },
        ],
      },
    );
    return missionForStaff(staff, view);
  }
}

export class RemoveInterventionPhotoUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { interventionId: string; fileId: string }): Promise<MissionView> {
    const staff = requireStaff(FIELD_WORK);
    const fileId = requireUuid('fileId', input.fileId);
    const { mission, intervention } = await staffIntervention(this.deps, staff, input.interventionId);
    editable(mission, intervention);
    if (!photoKindOf(intervention, fileId))
      return missionForStaff(staff, await missionView(this.deps, mission));
    // Suppression chez file d'abord (idempotente) : une photo supprimée mais encore citée n'est plus
    // listée, et un nouvel essai retire la référence.
    await this.deps.photos.remove(fileId, intervention.id);
    const view = await saveMission(this.deps, withIntervention(mission, withoutPhoto(intervention, fileId)), {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'intervention.photo_removed',
          entityType: 'mission',
          entityId: mission.id,
          at: this.deps.clock.now(),
          details: { interventionId: intervention.id, fileId },
        },
      ],
    });
    return missionForStaff(staff, view);
  }
}

/** Photos d'un passage pour le back-office : supervision, ou agent du passage. */
export class ListInterventionPhotosUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(interventionId: string): Promise<InterventionPhoto[]> {
    const staff = requireStaff(FIELD_WORK);
    const { intervention } = await staffIntervention(this.deps, staff, interventionId);
    return photosOf(this.deps, intervention);
  }
}

/**
 * Photos d'un passage d'une mission du client connecté (sinon introuvable) ; celle d'une organisation,
 * seulement dans le contexte actif de cette organisation (ADR-049), en lecture (org_viewer compris).
 */
export class ListMyInterventionPhotosUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(interventionIdInput: string): Promise<InterventionPhoto[]> {
    const customer = currentCustomer();
    const interventionId = requireUuid('interventionId', interventionIdInput);
    const mission = await this.deps.missions.findByInterventionId(interventionId);
    const intervention = mission?.interventions.find((item) => item.id === interventionId);
    if (!mission || !intervention || !ownsCase(customer, mission, 'read')) {
      throw CleaningErrors.interventionNotFound();
    }
    return photosOf(this.deps, intervention);
  }
}
