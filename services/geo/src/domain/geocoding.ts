/** Fournisseurs de géocodage inverse, dans l'ordre d'essai (ADR-034, ADR-045). */
export const GEOCODING_PROVIDERS = ['nominatim', 'google'] as const;
export type GeocodingProvider = (typeof GEOCODING_PROVIDERS)[number];

/** Réponse d'un fournisseur de géocodage inverse. */
export interface GeocodedPlace {
  provider: GeocodingProvider;
  /** Noms de commune possibles, du plus probable au moins probable (déjà dédoublonnés). */
  communes: string[];
  displayAddress: string | null;
}

/** Noms non vides, sans doublon, dans l'ordre reçu. */
export function addressCandidates(values: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
