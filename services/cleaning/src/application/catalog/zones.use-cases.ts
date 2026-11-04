import { isValidZoneCode, MAX_ZONE_ALIASES, type Zone, zoneCode } from '../../domain/zone';
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

/** Noms alternatifs d'une zone : textes non vides, distincts, différents du nom de la commune. */
function parseAliases(code: string, aliases: string[]): string[] {
  if (aliases.length > MAX_ZONE_ALIASES)
    throw CleaningErrors.invalid('aliases', `${MAX_ZONE_ALIASES} noms au plus.`);
  const keys = new Set<string>([code]);
  return aliases.map((alias, index) => {
    const name = requiredText(`aliases[${index}]`, alias, 100);
    const key = zoneCode(name);
    if (!isValidZoneCode(key) || keys.has(key)) {
      throw CleaningErrors.invalid(`aliases[${index}]`, 'Nom alternatif invalide ou en double.');
    }
    keys.add(key);
    return name;
  });
}

/**
 * Ajoute une commune aux zones desservies, ou la réactive si elle existe déjà. Noms alternatifs
 * (ADR-034) : absents, ceux en vigueur sont gardés ; présents, ils les remplacent.
 */
export class SaveZoneUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { commune: string; aliases?: string[] | null | undefined }): Promise<Zone> {
    const staff = requireStaff(ADMINISTRATION);
    const commune = requiredText('commune', input.commune, 100);
    const code = zoneCode(commune);
    if (!isValidZoneCode(code)) throw CleaningErrors.invalid('commune', 'Nom de commune invalide.');
    const existing = (await this.deps.catalog.listZones()).find((candidate) => candidate.code === code);
    const aliases = input.aliases ? parseAliases(code, input.aliases) : (existing?.aliases ?? []);
    const now = this.deps.clock.now();
    const zone: Zone = { code, commune, aliases, active: true, updatedBy: staff.userId, updatedAt: now };
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
