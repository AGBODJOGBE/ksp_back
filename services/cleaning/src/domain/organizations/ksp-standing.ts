/**
 * Décision de KSP sur une organisation (lot F ; `identity.organization.suspended` et
 * `.reactivated`, RV-85). cleaning garde la dernière décision appliquée et sa date (`occurredAt` de
 * l'événement) : un événement plus ancien est ignoré ; à date égale, la suspension l'emporte.
 */
export interface KspDecision {
  suspended: boolean;
  /** Date de la décision (`occurredAt` de l'événement). */
  changedAt: Date;
}

/** La décision reçue remplace-t-elle la dernière décision appliquée ? */
export function supersedesKspDecision(current: KspDecision | null, incoming: KspDecision): boolean {
  if (!current) return true;
  const gap = incoming.changedAt.getTime() - current.changedAt.getTime();
  if (gap !== 0) return gap > 0;
  return incoming.suspended && !current.suspended;
}
