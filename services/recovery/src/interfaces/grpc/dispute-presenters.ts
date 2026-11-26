import { type recoveryV1 } from '@ksp/contracts';
import { type AnsweredDispute } from '../../application/amicable/dispute-responses';
import { presentDispute } from './money-presenters';

/**
 * Contestation avec la réponse du créancier (décision `dispute_response`) : statut
 * `creditor_answered` tant que le juriste n'a pas tranché, texte et pièces du créancier.
 */
export function presentAnsweredDispute({ dispute, answer }: AnsweredDispute): recoveryV1.Dispute {
  return {
    ...presentDispute(dispute),
    creditorAnswer: answer?.comment ?? '',
    creditorFileIds: answer?.fileIds ?? [],
  };
}
