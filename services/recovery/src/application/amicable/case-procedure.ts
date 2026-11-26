import { type PlanStatus } from '../../domain/payment-plan';
import { type MoneyCaseView } from '../money/money-views';
import {
  type AmicableDeps,
  type PlanRecord,
  type PromiseRecord,
  type SettlementRecord,
} from './amicable.ports';
import { type AnsweredDispute, disputesWithAnswers } from './dispute-responses';

/** Échéancier en cours : en cours d'accord (proposé, soumis au créancier) ou signé et suivi. */
const CURRENT_PLAN: ReadonlySet<PlanStatus> = new Set(['proposed', 'pending_creditor', 'signed']);

/**
 * Fiche du dossier complétée de la procédure amiable (lot R4) : échéancier en cours et ses
 * échéances, promesses de paiement, remises pour paiement immédiat, et réponse du créancier aux
 * contestations (décision `dispute_response`).
 */
export interface ProcedureCaseView {
  money: MoneyCaseView;
  currentPlan: PlanRecord | null;
  promises: PromiseRecord[];
  settlements: SettlementRecord[];
  disputes: AnsweredDispute[];
}

const newestFirst = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

/**
 * Procédure amiable d'un dossier déjà lu et autorisé (GetCase du back-office, GetMyCase du
 * créancier), comme l'argent de R3 : lecture seule, les plus récents d'abord.
 */
export class AddCaseProcedureUseCase {
  constructor(private readonly deps: Pick<AmicableDeps, 'amicable'>) {}

  async execute(view: MoneyCaseView): Promise<ProcedureCaseView> {
    const caseId = view.view.record.id;
    const [plans, promises, settlements, disputes] = await Promise.all([
      this.deps.amicable.plans(caseId),
      this.deps.amicable.promises(caseId),
      this.deps.amicable.settlements(caseId),
      disputesWithAnswers(this.deps, view.disputes),
    ]);
    return {
      money: view,
      currentPlan: [...plans].sort(newestFirst).find((plan) => CURRENT_PLAN.has(plan.status)) ?? null,
      promises: [...promises].sort(newestFirst),
      settlements: [...settlements].sort(newestFirst),
      disputes,
    };
  }
}
