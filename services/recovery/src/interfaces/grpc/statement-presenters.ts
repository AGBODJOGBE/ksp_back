import { type recoveryV1 } from '@ksp/contracts';
import { type StatementRecord } from '../../application/statements/statements.ports';
import { money } from './presenters';

/** Relevé mensuel d'un dossier (R-CO-05) : montants du mois, PDF, facture de commission de billing. */
export function presentStatement(statement: StatementRecord): recoveryV1.Statement {
  return {
    id: statement.id,
    period: statement.period,
    caseId: statement.caseId,
    caseNumber: statement.caseNumber,
    collected: money(statement.collected),
    commission: money(statement.commission),
    costs: money(statement.costs),
    remitted: money(statement.remitted),
    documentId: statement.documentId,
    invoiceId: statement.invoiceId ?? '',
    issuedAt: statement.issuedAt.toISOString(),
  };
}
