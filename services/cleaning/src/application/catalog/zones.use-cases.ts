import { isValidZoneCode, MAX_ZONE_ALIASES, type Zone, zoneCode, zoneKeys } from '../../domain/zone';
import { type CleaningDeps } from '../deps';
import { type ZoneActivity } from '../ports';
import { ADMINISTRATION, requireStaff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { requiredText } from '../shared/validation';

/** Zone et son activité : demandes ouvertes et missions actives (ADR-035). */
export interface ZoneView {
  zone: Zone;
  activity: ZoneActivity;
}

/** Activité d'une zone : sa commune et ses noms alternatifs. */
function activityOf(zone: Zone, byCode: Map<string, ZoneActivity>): ZoneActivity {
  return zoneKeys(zone).reduce<ZoneActivity>(
    (sum, key) => ({
      openRequests: sum.openRequests + (byCode.get(key)?.openRequests ?? 0),
      activeMissions: sum.activeMissions + (byCode.get(key)?.activeMissions ?? 0),
    }),
    { openRequests: 0, activeMissions: 0 },
  );
}

async function withActivity(deps: CleaningDeps, zones: Zone[]): Promise<ZoneView[]> {
  const byCode = await deps.requests.zoneActivity(deps.clock.now());
  return zones.map((zone) => ({ zone, activity: activityOf(zone, byCode) }));
}

/** Zones desservies, actives et désactivées (admin), avec leur activité. */
export class ListZonesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<ZoneView[]> {
    requireStaff(ADMINISTRATION);
    return withActivity(this.deps, await this.deps.catalog.listZones());
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

  async execute(input: { commune: string; aliases?: string[] | null | undefined }): Promise<ZoneView> {
    const staff = requireStaff(ADMINISTRATION);
    const commune = requiredText('commune', input.commune, 100);
    const code = zoneCode(commune);
    if (!isValidZoneCode(code)) throw CleaningErrors.invalid('commune', 'Nom de commune invalide.');
    const existing = (await this.deps.catalog.listZones()).find((candidate) => candidate.code === code);
    const aliases = input.aliases ? parseAliases(code, input.aliases) : (existing?.aliases ?? []);
    const now = this.deps.clock.now();
    const zone: Zone = { code, commune, aliases, active: true, updatedBy: staff.userId, updatedAt: now };
    const saved = await this.deps.catalog.saveZone(zone, {
      events: [],
      audit: [{ actorId: staff.userId, action: 'zone.saved', entityType: 'zone', entityId: code, at: now }],
    });
    return (await withActivity(this.deps, [saved]))[0]!;
  }
}

/**
 * Désactive une zone : les nouvelles demandes y sont refusées, les demandes et missions en cours
 * continuent. Avec des demandes ouvertes ou des missions actives, une confirmation explicite est
 * exigée (CLEANING_ZONE_HAS_ACTIVITY, ADR-035).
 */
export class DeactivateZoneUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { code: string; confirm?: boolean }): Promise<ZoneView> {
    const staff = requireStaff(ADMINISTRATION);
    const zone = (await this.deps.catalog.listZones()).find((candidate) => candidate.code === input.code);
    if (!zone) throw CleaningErrors.zoneNotFound();
    const [{ activity }] = (await withActivity(this.deps, [zone])) as [ZoneView];
    if ((activity.openRequests || activity.activeMissions) && !input.confirm) {
      throw CleaningErrors.zoneHasActivity(activity.openRequests, activity.activeMissions);
    }
    const now = this.deps.clock.now();
    const saved = await this.deps.catalog.saveZone(
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
            details: { ...activity, confirmed: Boolean(input.confirm) },
          },
        ],
      },
    );
    return { zone: saved, activity };
  }
}
