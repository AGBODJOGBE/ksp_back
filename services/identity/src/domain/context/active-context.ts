/**
 * Contexte actif d'une session (UC-ID-15), écrit dans le claim ctx du jeton d'accès : "personal"
 * ou l'identifiant d'une organisation. Les services métier en déduisent le type de client
 * (cleaning : une entreprise règle par facture mensuelle) ; identity expose la même lecture aux
 * fronts. Une session s'ouvre dans le contexte personnel ; SwitchContext active une organisation
 * validée dont l'utilisateur est membre (ADR-027).
 */
export const PERSONAL_CONTEXT = 'personal';

/** Particulier (contexte personnel) ou entreprise (organisation active). */
export type ContextType = 'individual' | 'business';

export interface ActiveContext {
  type: ContextType;
  /** Organisation active d'une entreprise ; null pour un particulier. */
  organizationId: string | null;
  /** Raison sociale de l'organisation active, affichée par les fronts ; null pour un particulier. */
  organizationName: string | null;
}

/** Même règle que cleaning et billing : tout contexte autre que personnel est une organisation. */
export function activeContextOf(ctx: string, organizationName: string | null = null): ActiveContext {
  if (!ctx || ctx === PERSONAL_CONTEXT) {
    return { type: 'individual', organizationId: null, organizationName: null };
  }
  return { type: 'business', organizationId: ctx, organizationName };
}
