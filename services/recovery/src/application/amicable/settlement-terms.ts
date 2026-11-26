import { localDay, localInstant } from '../../domain/calendar';
import { SYSTEM } from '../cases/case-rules';
import { noChanges } from '../cases/ports';
import { type PayableSettlement, type SettlementTerms } from '../debtor-space/settlement-terms';
import { type CaseClosure } from '../money/case-closure.service';
import { type AmicableDeps, noAmicableChanges } from './amicable.ports';

/** Remise encore payable par lien : proposée au débiteur, ou acceptée par le créancier. */
const PAYABLE = new Set(['proposed', 'accepted']);

/**
 * Remises de la procédure amiable (R4) branchées sur le paiement du débiteur (R3, R-PR-05) : une
 * remise payable ouvre un lien du montant à payer tout de suite ; payée, elle est exécutée et le
 * dossier est clos « accord transactionnel exécuté », le reste étant abandonné.
 */
export class AmicableSettlementTerms implements SettlementTerms {
  constructor(
    private readonly deps: Omit<AmicableDeps, 'escalations'>,
    private readonly closure: CaseClosure,
  ) {}

  async payable(input: {
    caseId: string;
    settlementId: string;
    at: Date;
  }): Promise<PayableSettlement | null> {
    const settlement = await this.deps.amicable.settlement(input.settlementId);
    if (!settlement || settlement.caseId !== input.caseId || !PAYABLE.has(settlement.status)) return null;
    if (settlement.validUntil < localDay(input.at)) return null;
    return {
      id: settlement.id,
      caseId: settlement.caseId,
      payNow: settlement.payNow,
      // Valable jusqu'à la fin du jour indiqué, heure du Bénin.
      validUntil: localInstant(settlement.validUntil, 23, 59),
    };
  }

  /** Idempotent : une remise déjà exécutée ne fait plus que clore le dossier s'il est encore ouvert. */
  async paid(input: { settlementId: string; caseId: string; collectionId: string; at: Date }): Promise<void> {
    const settlement = await this.deps.amicable.settlement(input.settlementId);
    if (!settlement || settlement.caseId !== input.caseId) return;
    if (settlement.status !== 'executed') {
      const outcome = await this.deps.amicable.commit({
        touch: { caseId: input.caseId, at: input.at },
        changes: noChanges(),
        amicable: {
          ...noAmicableChanges(),
          settlements: [
            { row: { ...settlement, status: 'executed', answeredAt: input.at }, expected: settlement.status },
          ],
        },
      });
      if (outcome !== 'saved') throw new Error(`Remise ${settlement.id} non exécutée (${outcome}).`);
    }
    const record = await this.deps.cases.find(input.caseId);
    if (record && (record.status === 'active' || record.status === 'suspended')) {
      await this.closure.close(input.caseId, {
        reason: 'settlement_executed',
        actor: SYSTEM,
        note: null,
        staff: null,
      });
    }
  }
}
