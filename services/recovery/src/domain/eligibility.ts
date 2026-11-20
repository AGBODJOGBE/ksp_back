import { type LocalDay } from './calendar';

/**
 * Injonction de payer (Acte uniforme OHADA, partie 2 ; étape 6) : ouverte à une créance certaine,
 * liquide et exigible, d'origine contractuelle ou issue d'un effet de commerce ou d'un chèque. Sinon,
 * action en paiement par un avocat. Le juriste confirme toujours ; le domaine ne fait que proposer.
 */
/** Nature de la créance (`RecoveryCase.nature` du contrat). */
export type ClaimNature =
  | 'unpaid_invoice'
  | 'loan'
  | 'acknowledgment_of_debt'
  | 'bounced_cheque'
  | 'service'
  | 'sale'
  | 'rent'
  | 'other';

/** Natures d'origine contractuelle, ou effet de commerce et chèque. « Autre » demande l'avis du juriste. */
const ELIGIBLE_ORIGINS: ReadonlySet<ClaimNature> = new Set([
  'unpaid_invoice',
  'loan',
  'acknowledgment_of_debt',
  'bounced_cheque',
  'service',
  'sale',
  'rent',
]);

export interface EligibilityInput {
  nature: ClaimNature;
  /** Contestation en cours ou fondée : la créance n'est pas certaine. */
  disputed: boolean;
  /** Au moins une pièce prouve la créance (4.1, étape 4). */
  hasEvidence: boolean;
  /** Montant chiffré en argent (principal connu, intérêts calculés selon le contrat). */
  amountDetermined: boolean;
  dueDay: LocalDay;
  today: LocalDay;
}

export type EligibilityCriterion = 'certain' | 'liquid' | 'due' | 'origin';

export interface Eligibility {
  eligible: boolean;
  /** Critères non réunis. */
  unmet: EligibilityCriterion[];
}

export function payOrderEligibility(input: EligibilityInput): Eligibility {
  const unmet: EligibilityCriterion[] = [];
  if (input.disputed || !input.hasEvidence) unmet.push('certain');
  if (!input.amountDetermined) unmet.push('liquid');
  if (input.dueDay > input.today) unmet.push('due');
  if (!ELIGIBLE_ORIGINS.has(input.nature)) unmet.push('origin');
  return { eligible: unmet.length === 0, unmet };
}
