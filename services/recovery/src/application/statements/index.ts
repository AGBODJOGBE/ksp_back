import {
  IssueMonthlyStatementsUseCase,
  ListMyStatementsUseCase,
  RecordCommissionInvoiceUseCase,
  type StatementDeps,
} from './statements.use-cases';

/**
 * Cas d'usage des relevés mensuels (R-CO-05) : liste du créancier, production chaque mois (tâche
 * planifiée) et rattachement de la facture de commission de billing.
 */
export function createStatementUseCases(deps: StatementDeps) {
  return {
    listMyStatements: new ListMyStatementsUseCase(deps),
    issueMonthlyStatements: new IssueMonthlyStatementsUseCase(deps),
    recordCommissionInvoice: new RecordCommissionInvoiceUseCase(deps),
  };
}

export type { StatementDeps } from './statements.use-cases';
export type { StatementStore } from './statements.ports';
