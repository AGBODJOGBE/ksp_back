import { normalizeCommune } from './catalog';

/**
 * Zones desservies (décision du 2026-10-23) : le Nettoyage n'est ouvert que dans certaines
 * communes, au départ Cotonou, Porto-Novo et Abomey-Calavi ; l'admin en ajoute ou en désactive.
 * Une zone est une commune, identifiée par la même clé normalisée que les coefficients de
 * commune de la grille tarifaire : « Abomey Calavi », « abomey-calavi » et « Abomey-Calavi »
 * désignent la même zone, et le coefficient de cette commune s'y applique.
 */
export interface Zone {
  code: string;
  commune: string;
  /**
   * Autres noms de la commune (« Sèmè-Kpodji » pour « Sèmè-Podji »), pour rattacher le nom rendu
   * par un géocodeur à la zone (ADR-034).
   */
  aliases: string[];
  active: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export const INITIAL_ZONES = ['Cotonou', 'Porto-Novo', 'Abomey-Calavi'] as const;

export const zoneCode = normalizeCommune;

/** Clé utilisable : lettres, chiffres et tirets, commençant par une lettre. */
export function isValidZoneCode(code: string): boolean {
  return /^[a-z][a-z0-9-]{1,99}$/.test(code);
}

export const MAX_ZONE_ALIASES = 20;

/** Clés sous lesquelles une zone est reconnue : son code et ceux de ses noms alternatifs. */
export function zoneKeys(zone: Pick<Zone, 'code' | 'aliases'>): string[] {
  return [zone.code, ...zone.aliases.map(zoneCode)];
}

/** Zone active reconnue sous cette clé (code ou nom alternatif normalisé), sinon undefined. */
export function findActiveZone(zones: readonly Zone[], key: string): Zone | undefined {
  return zones.find((zone) => zone.active && zoneKeys(zone).includes(key));
}

/** La commune est-elle dans une zone active (par son nom ou un nom alternatif) ? */
export function isCovered(zones: readonly Zone[], commune: string): boolean {
  return findActiveZone(zones, zoneCode(commune)) !== undefined;
}
