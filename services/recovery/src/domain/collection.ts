import { type Allocation, allocate, type CaseAmounts, commissionBase, totalDue } from './amounts';
import { type CaseStage, stageGroup, type StageGroup } from './case';
import { BASIS_POINTS, isWholeAmount } from './money';
import { type Outcome, refusal, success } from './outcome';
import { type BoundApplied, commission, type PricingRule } from './pricing';

/**
 * Encaissement d'un dossier (R-EN-03, R-CO-01 à 03 ; message `Collection` du contrat), quelle que
 * soit son origine : lien de paiement, paiement hors ligne validé, encaissement d'un partenaire validé,
 * paiement reçu directement par le créancier. Imputation frais → intérêts → principal, trop-perçu
 * au-delà du dû ; commission selon la règle figée sur le dossier, sur le cumul encaissé ; net crédité
 * au créancier tout de suite (ADR-060, point 6), sauf pour un paiement direct, dont la commission lui
 * est facturée par billing.
 */
export type CollectionSource =
  'payment_link' | 'offline_cash' | 'offline_transfer' | 'partner' | 'direct_to_creditor';

/** Commission retenue sur l'encaissement, ou facturée au créancier (paiement direct, ADR-060 point 11). */
export type CommissionSettlement = 'deducted' | 'invoiced';

/** Cumuls de commission du dossier (tranches progressives et minimum au cumul, ADR-062). */
export interface CommissionTotals {
  /** Base déjà commissionnée (intérêts et principal encaissés). */
  base: number;
  /** Commission déjà prise sur le dossier, retenue ou facturée. */
  commission: number;
}

export interface CollectionInput {
  gross: number;
  source: CollectionSource;
  amounts: CaseAmounts;
  /** Étape la plus avancée atteinte : elle fixe le groupe d'étapes de la commission (R-CO-01). */
  highestStage: CaseStage | null;
  /** Règle de commission figée dans le mandat (R-CO-02). */
  rule: PricingRule;
  totals: CommissionTotals;
  /** Faux pour un paiement direct reçu plus de 30 jours après l'arrêt du dossier (R-PR-06). */
  commissionDue: boolean;
  /** Dossier encore ouvert : l'encaissement qui solde le dû le clôt (motif « payé »). */
  open: boolean;
}

export interface CollectionComputation {
  allocation: Allocation;
  commissionBase: number;
  commission: number;
  boundApplied: BoundApplied;
  settlement: CommissionSettlement;
  stageGroup: StageGroup;
  /** Part du créancier confiée à wallet : brut hors trop-perçu ; 0 pour un paiement direct. */
  creditedGross: number;
  /** Net crédité au créancier : part du créancier moins la commission ; 0 pour un paiement direct. */
  net: number;
  /** Taux effectif de la commission sur la part du créancier, pour le relevé de wallet. */
  effectiveRateBps: number;
  dueBefore: number;
  dueAfter: number;
  /** Cet encaissement solde le dossier : clôture « payé » et attestation de solde. */
  closesCase: boolean;
  totalsAfter: CommissionTotals;
  amountsAfter: CaseAmounts;
}

/**
 * Calcul d'un encaissement, sans l'appliquer. Le trop-perçu n'est ni commissionné ni crédité : il est
 * noté sur le dossier et remboursé à la main par la finance (ADR-060, point 9). Les frais de procédure
 * recouvrés reviennent au créancier, qui les a provisionnés (R-CO-06) : ils sont dans le net.
 */
export function computeCollection(input: CollectionInput): Outcome<CollectionComputation> {
  if (!isWholeAmount(input.gross) || input.gross === 0) {
    return refusal('RECOVERY_INVALID_AMOUNT', 'Encaissement entier et strictement positif');
  }
  const dueBefore = totalDue(input.amounts);
  const allocation = allocate(input.amounts, input.gross);
  const base = commissionBase(allocation);
  const dueAfter = dueBefore - (input.gross - allocation.overpayment);
  const closesCase = input.open && dueBefore > 0 && dueAfter === 0;
  const group = stageGroup(input.highestStage);
  const priced = input.commissionDue
    ? commission(input.rule, {
        base,
        collectedBefore: input.totals.base,
        commissionBefore: input.totals.commission,
        stageGroup: group,
        closesCase,
      })
    : { commission: 0, net: base, boundApplied: null };
  const direct = input.source === 'direct_to_creditor';
  const share = input.gross - allocation.overpayment;
  return success({
    allocation,
    commissionBase: base,
    commission: priced.commission,
    boundApplied: priced.boundApplied,
    settlement: direct ? 'invoiced' : 'deducted',
    stageGroup: group,
    creditedGross: direct ? 0 : share,
    net: direct ? 0 : share - priced.commission,
    effectiveRateBps: share > 0 ? Math.floor((priced.commission * BASIS_POINTS) / share) : 0,
    dueBefore,
    dueAfter,
    closesCase,
    totalsAfter: {
      base: input.totals.base + (input.commissionDue ? base : 0),
      commission: input.totals.commission + priced.commission,
    },
    amountsAfter: {
      costs: { ...input.amounts.costs, paid: input.amounts.costs.paid + allocation.costs },
      interests: { ...input.amounts.interests, paid: input.amounts.interests.paid + allocation.interests },
      principal: { ...input.amounts.principal, paid: input.amounts.principal.paid + allocation.principal },
    },
  });
}
