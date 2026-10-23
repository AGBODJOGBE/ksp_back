/** Réglages de la facturation, modifiables au back-office (CDC Nettoyage, partie 10). */
export interface BillingSettings {
  /** Délai de règlement après l'émission d'une facture (10 jours par défaut). */
  paymentTermDays: number;
}

export const DEFAULT_BILLING_SETTINGS: BillingSettings = { paymentTermDays: 10 };

export const PAYMENT_TERM_BOUNDS: [number, number] = [1, 90];

/** Champs hors bornes, vide si les réglages sont valides. */
export function billingSettingsProblems(settings: BillingSettings): string[] {
  const [min, max] = PAYMENT_TERM_BOUNDS;
  const value = settings.paymentTermDays;
  return Number.isInteger(value) && value >= min && value <= max ? [] : ['paymentTermDays'];
}
