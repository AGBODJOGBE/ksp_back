/**
 * Réglages du Nettoyage, modifiables au back-office (partie 4 du cahier des charges, valeurs
 * proposées, à confirmer).
 */
export interface CleaningSettings {
  quoteValidityDays: number;
  minimumLeadHours: number;
  freeCancellationHours: number;
  visitThresholdSquareMeters: number;
  maxOpenRequests: number;
  /** Acompte demandé quand le client choisit de ne payer qu'une partie (30 % par défaut). */
  depositPercent: number;
}

export const DEFAULT_SETTINGS: CleaningSettings = {
  quoteValidityDays: 15,
  minimumLeadHours: 48,
  freeCancellationHours: 24,
  visitThresholdSquareMeters: 300,
  maxOpenRequests: 5,
  depositPercent: 30,
};

const BOUNDS: Record<keyof CleaningSettings, [number, number]> = {
  quoteValidityDays: [1, 90],
  minimumLeadHours: [0, 720],
  freeCancellationHours: [0, 720],
  visitThresholdSquareMeters: [1, 100_000],
  maxOpenRequests: [1, 100],
  depositPercent: [0, 100],
};

/** Champs hors bornes, vide si les réglages sont valides. */
export function settingsProblems(settings: CleaningSettings): string[] {
  return (Object.keys(BOUNDS) as (keyof CleaningSettings)[]).filter((key) => {
    const value = settings[key];
    const [min, max] = BOUNDS[key];
    return !Number.isInteger(value) || value < min || value > max;
  });
}
