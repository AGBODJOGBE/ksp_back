import { isCancellableByCustomer, type Mission, nextStart } from '../../domain/mission';
import { isFreeCancellation } from '../../domain/schedule';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { type Changes } from '../ports';
import { currentCustomer } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { optionalText, type PageRequest, type PageResult } from '../shared/validation';

/** Mission du client, sinon introuvable (404, sans révéler le dossier d'un autre). */
async function ownMission(deps: CleaningDeps, missionId: string): Promise<Mission> {
  const customer = currentCustomer();
  const mission = await deps.missions.findById(missionId);
  if (!mission || mission.customerId !== customer.userId) throw CleaningErrors.missionNotFound();
  return mission;
}

/** Enregistre une mission modifiée (contrôle de version) et renvoie sa vue. */
export async function saveMission(
  deps: CleaningDeps,
  mission: Mission,
  changes: Changes,
): Promise<MissionView> {
  const next = { ...mission, updatedAt: deps.clock.now() };
  if (!(await deps.missions.save(next, changes))) throw CleaningErrors.concurrentUpdate();
  return missionView(deps, { ...next, version: next.version + 1 });
}

/** Annule la mission et ses passages non commencés (et lève une éventuelle suspension). */
export function cancelled(mission: Mission, reason: string | null, now: Date): Mission {
  return {
    ...mission,
    status: 'cancelled',
    cancellationReason: reason,
    suspension: null,
    interventions: mission.interventions.map((intervention) =>
      intervention.status === 'planned' || intervention.status === 'on_hold'
        ? { ...intervention, status: 'cancelled', cancellationCause: 'manual', cancelledAt: now }
        : intervention,
    ),
  };
}

/** UC-CL-03 : mes missions. */
export class ListMyMissionsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(page: PageRequest): Promise<PageResult<MissionView>> {
    const customer = currentCustomer();
    const result = await this.deps.missions.list({ customerId: customer.userId }, page);
    return {
      items: await Promise.all(result.items.map((mission) => missionView(this.deps, mission))),
      nextCursor: result.nextCursor,
    };
  }
}

/** UC-CL-03 : détail d'une de mes missions, avec l'équipe de chaque passage. */
export class GetMyMissionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(missionId: string): Promise<MissionView> {
    return missionView(this.deps, await ownMission(this.deps, missionId));
  }
}

/** UC-CL-05 : annuler sa mission, sans frais jusqu'au délai limite ; au-delà, par le support. */
export class CancelMyMissionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { missionId: string; reason: string }): Promise<MissionView> {
    const mission = await ownMission(this.deps, input.missionId);
    const now = this.deps.clock.now();
    if (!isCancellableByCustomer(mission))
      throw CleaningErrors.invalidTransition(mission.status, 'cancelled');
    const settings = await this.deps.catalog.getSettings();
    if (!isFreeCancellation(nextStart(mission), now, settings.freeCancellationHours)) {
      throw CleaningErrors.cancellationTooLate(settings.freeCancellationHours);
    }
    const reason = optionalText('reason', input.reason, 500);
    return saveMission(this.deps, cancelled(mission, reason, this.deps.clock.now()), {
      events: [
        {
          type: 'cleaning.request.cancelled',
          payload: {
            requestId: mission.requestId,
            missionId: mission.id,
            customerId: mission.customerId,
            cancelledBy: 'customer',
            outcome: 'cancelled',
          },
        },
      ],
      audit: [
        {
          actorId: mission.customerId,
          action: 'mission.cancelled',
          entityType: 'mission',
          entityId: mission.id,
          at: now,
        },
      ],
    });
  }
}
