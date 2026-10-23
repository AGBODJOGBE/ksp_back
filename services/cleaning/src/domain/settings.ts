/**
 * Réglages du Nettoyage, modifiables au back-office (parties 4 et 10 du cahier des charges).
 * Le délai de règlement des factures d'entreprise appartient au service billing.
 */
export interface CleaningSettings {
  quoteValidityDays: number;
  minimumLeadHours: number;
  freeCancellationHours: number;
  visitThresholdSquareMeters: number;
  maxOpenRequests: number;
  /** Acompte demandé quand le client choisit de ne payer qu'une partie (30 % par défaut). */
  depositPercent: number;
  /** Entreprise : factures impayées à partir desquelles le client est averti (1). */
  businessWarningUnpaidInvoices: number;
  /** Entreprise : factures impayées qui suspendent le contrat (2). */
  businessSuspensionUnpaidInvoices: number;
  /** Particulier en récurrent : passages impayés qui suspendent le service (1). */
  individualSuspensionUnpaidInterventions: number;
  /** Heures laissées après la fin d'un passage pour enregistrer son paiement (24). */
  individualPaymentGraceHours: number;
}

export const DEFAULT_SETTINGS: CleaningSettings = {
  quoteValidityDays: 15,
  minimumLeadHours: 48,
  freeCancellationHours: 24,
  visitThresholdSquareMeters: 300,
  maxOpenRequests: 5,
  depositPercent: 30,
  businessWarningUnpaidInvoices: 1,
  businessSuspensionUnpaidInvoices: 2,
  individualSuspensionUnpaidInterventions: 1,
  individualPaymentGraceHours: 24,
};

const BOUNDS: Record<keyof CleaningSettings, [number, number]> = {
  quoteValidityDays: [1, 90],
  minimumLeadHours: [0, 720],
  freeCancellationHours: [0, 720],
  visitThresholdSquareMeters: [1, 100_000],
  maxOpenRequests: [1, 100],
  depositPercent: [0, 100],
  businessWarningUnpaidInvoices: [1, 24],
  businessSuspensionUnpaidInvoices: [1, 24],
  individualSuspensionUnpaidInterventions: [1, 50],
  individualPaymentGraceHours: [1, 720],
};

/**
 * Champs hors bornes, vide si les réglages sont valides. L'avertissement doit précéder la
 * suspension : un seuil d'avertissement au moins égal à celui de suspension est refusé.
 */
export function settingsProblems(settings: CleaningSettings): string[] {
  const problems = (Object.keys(BOUNDS) as (keyof CleaningSettings)[]).filter((key) => {
    const value = settings[key];
    const [min, max] = BOUNDS[key];
    return !Number.isInteger(value) || value < min || value > max;
  });
  if (
    !problems.length &&
    settings.businessWarningUnpaidInvoices >= settings.businessSuspensionUnpaidInvoices
  ) {
    problems.push('businessWarningUnpaidInvoices');
  }
  return problems;
}

/** Réglages de la partie 10, ajoutés après coup : à l'écriture, 0 garde la valeur en vigueur. */
export const STANDING_SETTING_KEYS = [
  'businessWarningUnpaidInvoices',
  'businessSuspensionUnpaidInvoices',
  'individualSuspensionUnpaidInterventions',
  'individualPaymentGraceHours',
] as const;

export function mergeSettings(current: CleaningSettings, update: CleaningSettings): CleaningSettings {
  const merged = { ...update };
  for (const key of STANDING_SETTING_KEYS) {
    if (!merged[key]) merged[key] = current[key];
  }
  return merged;
}
