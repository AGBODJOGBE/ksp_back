/**
 * Contexte actif d'une session (UC-ID-15), écrit dans le claim ctx du jeton d'accès : "personal"
 * ou l'identifiant d'une organisation. Les services métier en déduisent le type de client
 * (cleaning : une entreprise règle par facture mensuelle) ; identity expose la même lecture aux
 * fronts. Seul le contexte personnel est ouvert aujourd'hui : les organisations et le changement
 * de contexte (UC-ID-12 à 16) viendront avec leurs cas d'usage.
 */
export const PERSONAL_CONTEXT = 'personal';

/** Particulier (contexte personnel) ou entreprise (organisation active). */
export type ContextType = 'individual' | 'business';

export interface ActiveContext {
  type: ContextType;
  /** Organisation active d'une entreprise ; null pour un particulier. */
  organizationId: string | null;
}

/** Même règle que cleaning et billing : tout contexte autre que personnel est une organisation. */
export function activeContextOf(ctx: string): ActiveContext {
  if (!ctx || ctx === PERSONAL_CONTEXT) return { type: 'individual', organizationId: null };
  return { type: 'business', organizationId: ctx };
}
