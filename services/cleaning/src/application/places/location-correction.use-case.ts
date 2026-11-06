import { isTerminalMission, type Mission } from '../../domain/mission';
import { type CleaningDeps, presentRequest } from '../deps';
import { requestForStaff, type StaffRequest } from '../groups/group-support';
import { anyRequest } from '../requests/admin-requests.use-cases';
import { FIELD_WORK, requireStaff, seesEverything } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { optionalText } from '../shared/validation';
import { chooseCommune, parseLocation } from './location.use-cases';

export interface CorrectLocationInput {
  requestId: string;
  location?: { latitude: number; longitude: number; accuracyMeters?: number | null | undefined } | undefined;
  /** Vide : repère en vigueur gardé. */
  landmark?: string | null | undefined;
  /** Repli si le géocodage ne trouve pas la commune. */
  commune?: string | null | undefined;
}

export interface CorrectedLocation {
  /** Sans montants pour un agent seul (ADR-037). */
  request: StaffRequest;
  requestIds: string[];
  missionIds: string[];
}

/**
 * Correction de la position d'une demande (ADR-035), par la supervision ou par l'agent de la visite
 * encore planifiée de cette demande. La commune est recalculée (géocodeur, repli sur la commune
 * fournie) ; la correction s'applique à toutes les demandes du groupe et aux missions non
 * terminées, dans une transaction ; le journal d'audit la trace sans les coordonnées. Les devis et
 * calculs déjà faits ne sont pas recalculés.
 */
export class CorrectLocationUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: CorrectLocationInput): Promise<CorrectedLocation> {
    const staff = requireStaff(FIELD_WORK);
    const target = await anyRequest(this.deps, input.requestId);
    const assigned = target.visit?.status === 'scheduled' && target.visit.agentId === staff.userId;
    if (!seesEverything(staff) && !assigned) throw CleaningErrors.requestNotFound();

    const location = parseLocation(input.location ?? undefined);
    const landmark = optionalText('landmark', input.landmark ?? undefined, 500);
    const fallback = optionalText('commune', input.commune ?? undefined, 100);
    const { commune, provider, displayAddress } = await chooseCommune(this.deps, location, fallback);
    const now = this.deps.clock.now();

    const requests = target.groupId
      ? ((await this.deps.requests.findGroup(target.groupId))?.requests ?? [target])
      : [target];
    const missions: Mission[] = target.groupId
      ? await this.deps.missions.listForGroup(target.groupId)
      : target.missionId
        ? [await this.deps.missions.findById(target.missionId)].filter((m): m is Mission => m !== null)
        : [];
    const active = missions.filter((mission) => !isTerminalMission(mission.status));

    const place = <T extends { address: string; landmark: string | null; placeType: string | null }>(
      record: T,
    ) => {
      const nextLandmark = landmark ?? record.landmark;
      // Parcours par lieu (ADR-034) : le repère tient lieu d'adresse.
      const address = record.placeType && nextLandmark ? nextLandmark : record.address;
      return { ...record, location, landmark: nextLandmark, address, commune, updatedAt: now };
    };
    const updatedRequests = requests.map((request) => ({
      ...place(request),
      geocodingProvider: provider,
      geocodedAddress: displayAddress,
    }));
    const updatedMissions = active.map((mission) => place(mission));

    const written = await this.deps.requests.saveGroup({
      requests: updatedRequests,
      missions: updatedMissions,
      changes: {
        events: [],
        audit: [
          {
            actorId: staff.userId,
            action: 'request.location_corrected',
            entityType: 'quote_request',
            entityId: target.id,
            at: now,
            // Jamais de coordonnées ni de repère dans le journal (ADR-034).
            details: {
              groupId: target.groupId,
              requestIds: updatedRequests.map((request) => request.id),
              missionIds: updatedMissions.map((mission) => mission.id),
              geocodingProvider: provider,
              communeChanged: commune !== target.commune,
              byAgent: !seesEverything(staff),
            },
          },
        ],
      },
    });
    if (written !== 'saved') throw CleaningErrors.concurrentUpdate();
    const saved = updatedRequests.find((request) => request.id === target.id)!;
    return {
      request: requestForStaff(staff, presentRequest({ ...saved, version: saved.version + 1 }, now)),
      requestIds: updatedRequests.map((request) => request.id),
      missionIds: updatedMissions.map((mission) => mission.id),
    };
  }
}
