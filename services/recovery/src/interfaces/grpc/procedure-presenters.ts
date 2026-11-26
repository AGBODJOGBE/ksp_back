import { type recoveryV1 } from '@ksp/contracts';
import { type ProcedureCaseView } from '../../application/amicable/case-procedure';
import { presentPlan, presentPromise, presentSettlement } from './amicable-presenters';
import { presentAnsweredDispute } from './dispute-presenters';
import { presentMoneyCase } from './money-presenters';

/**
 * Fiche du dossier (GetCase, GetMyCase) complétée de la procédure amiable : échéancier en cours,
 * promesses, remises (`settlements`, ajout facultatif du contrat) et réponse du créancier aux
 * contestations.
 */
export function presentProcedureCase(view: ProcedureCaseView): recoveryV1.RecoveryCase {
  return {
    ...presentMoneyCase(view.money),
    currentPlan: view.currentPlan ? presentPlan(view.currentPlan) : undefined,
    promises: view.promises.map(presentPromise),
    settlements: view.settlements.map(presentSettlement),
    disputes: view.disputes.map(presentAnsweredDispute),
  };
}
