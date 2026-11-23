import { BASIS_POINTS } from './money';

/**
 * Huissiers et avocats partenaires (partie 8). Le système propose le partenaire du ressort du débiteur
 * le moins chargé et le plus efficace ; le juriste confirme ou en choisit un autre (R-HU-02).
 */
export type PartnerKind = 'bailiff' | 'lawyer';
export type PartnerStatus = 'pending_verification' | 'active' | 'suspended';

export interface PartnerProfile {
  id: string;
  kind: PartnerKind;
  status: PartnerStatus;
  /** Ressort géographique : clés de commune (geo). */
  areas: string[];
  /** Dossiers en cours chez ce partenaire. */
  openAssignments: number;
  /** Dossiers terminés et, parmi eux, ceux recouvrés (taux de succès, R-HU-01). */
  closedAssignments: number;
  successfulAssignments: number;
  /** Délai moyen observé, en jours ; null sans historique. */
  averageDays: number | null;
}

const PARTNER_TRANSITIONS: Record<PartnerStatus, readonly PartnerStatus[]> = {
  // Activation seulement après vérification de la nomination ou de l'inscription au barreau (R-HU-01).
  pending_verification: ['active'],
  active: ['suspended'],
  suspended: ['active'],
};

export function canTransitionPartner(from: PartnerStatus, to: PartnerStatus): boolean {
  return PARTNER_TRANSITIONS[from].includes(to);
}

/** Taux de succès en points de base ; sans historique, neutre (50 %) pour ne pas écarter un nouveau. */
export function successRateBp(partner: PartnerProfile): number {
  if (partner.closedAssignments === 0) return BASIS_POINTS / 2;
  return Math.floor((partner.successfulAssignments * BASIS_POINTS) / partner.closedAssignments);
}

/**
 * Partenaires proposés pour un dossier, du meilleur au moins bon : actifs, du bon métier, couvrant la
 * commune du débiteur ; triés par charge croissante, puis taux de succès décroissant, puis délai moyen.
 */
export function suggestPartners(
  partners: readonly PartnerProfile[],
  kind: PartnerKind,
  debtorArea: string,
): PartnerProfile[] {
  return partners
    .filter((p) => p.status === 'active' && p.kind === kind && p.areas.includes(debtorArea))
    .sort(
      (a, b) =>
        a.openAssignments - b.openAssignments ||
        successRateBp(b) - successRateBp(a) ||
        (a.averageDays ?? Number.MAX_SAFE_INTEGER) - (b.averageDays ?? Number.MAX_SAFE_INTEGER),
    );
}

/** Sans mise à jour depuis N jours (`partnerSilenceAlertDays`, 15), le juriste est alerté (R-HU-04). */
export function isPartnerSilent(lastUpdateAt: Date, now: Date, partnerSilenceAlertDays: number): boolean {
  return now.getTime() - lastUpdateAt.getTime() >= partnerSilenceAlertDays * 86_400_000;
}
