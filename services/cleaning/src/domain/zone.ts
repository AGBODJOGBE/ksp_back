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

/** La commune est-elle dans une zone active ? */
export function isCovered(zones: readonly Zone[], commune: string): boolean {
  const code = zoneCode(commune);
  return zones.some((zone) => zone.active && zone.code === code);
}
