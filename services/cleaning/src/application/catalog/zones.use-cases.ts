import { isValidZoneCode, type Zone, zoneCode } from '../../domain/zone';
import { type CleaningDeps } from '../deps';
import { ADMINISTRATION, requireStaff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { requiredText } from '../shared/validation';

/** Zones desservies, actives et désactivées (admin). */
export class ListZonesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<Zone[]> {
    requireStaff(ADMINISTRATION);
    return this.deps.catalog.listZones();
  }
}

/** Ajoute une commune aux zones desservies, ou la réactive si elle existe déjà. */
export class SaveZoneUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { commune: string }): Promise<Zone> {
    const staff = requireStaff(ADMINISTRATION);
    const commune = requiredText('commune', input.commune, 100);
    const code = zoneCode(commune);
    if (!isValidZoneCode(code)) throw CleaningErrors.invalid('commune', 'Nom de commune invalide.');
    const now = this.deps.clock.now();
    const zone: Zone = { code, commune, active: true, updatedBy: staff.userId, updatedAt: now };
    return this.deps.catalog.saveZone(zone, {
      events: [],
      audit: [{ actorId: staff.userId, action: 'zone.saved', entityType: 'zone', entityId: code, at: now }],
    });
  }
}

/** Désactive une zone : les nouvelles demandes y sont refusées, les missions en cours continuent. */
export class DeactivateZoneUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { code: string }): Promise<Zone> {
    const staff = requireStaff(ADMINISTRATION);
    const zone = (await this.deps.catalog.listZones()).find((candidate) => candidate.code === input.code);
    if (!zone) throw CleaningErrors.zoneNotFound();
    const now = this.deps.clock.now();
    return this.deps.catalog.saveZone(
      { ...zone, active: false, updatedBy: staff.userId, updatedAt: now },
      {
        events: [],
        audit: [
          {
            actorId: staff.userId,
            action: 'zone.deactivated',
            entityType: 'zone',
            entityId: zone.code,
            at: now,
          },
        ],
      },
    );
  }
}
