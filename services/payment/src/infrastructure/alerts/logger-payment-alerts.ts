import { Logger } from '@nestjs/common';
import { type PaymentAlerts } from '../../application/ports';

/**
 * Alertes de paiement au journal d'erreurs (supervision : alerte sur le contexte `PaymentAlert`).
 * Identifiants et montants seulement : ni nom, ni téléphone, ni corps reçu.
 */
export class LoggerPaymentAlerts implements PaymentAlerts {
  private readonly logger = new Logger('PaymentAlert');

  amountMismatch(input: {
    paymentId: string;
    transactionId: string;
    expectedAmount: number;
    approvedAmount: number;
    currency: string;
  }): void {
    this.logger.error(
      `Montant approuvé différent : paiement ${input.paymentId}, transaction ${input.transactionId}, ` +
        `attendu ${input.expectedAmount} XOF, approuvé ${input.approvedAmount} ${input.currency} ` +
        '(statut amount_mismatch, à trancher par la finance)',
    );
  }

  transactionMismatch(input: {
    paymentId: string;
    expectedTransactionId: string | null;
    receivedTransactionId: string;
    receivedPaymentId: string | null;
  }): void {
    this.logger.error(
      `Transaction relue qui ne correspond pas : paiement ${input.paymentId}, transaction attendue ` +
        `${input.expectedTransactionId ?? '(aucune)'}, reçue ${input.receivedTransactionId} ` +
        `(payment_id ${input.receivedPaymentId ?? 'absent'}) ; ignorée`,
    );
  }

  unrecordedPayment(input: {
    subjectType: string;
    subjectId: string;
    paymentIds: string[];
    since: Date;
  }): void {
    this.logger.error(
      `ALERTE paiement : paiement(s) réussi(s) ${input.paymentIds.join(', ')} non enregistré(s) pour ` +
        `${input.subjectType} ${input.subjectId} depuis ${input.since.toISOString()} ; nouveau paiement ` +
        'refusé (PAYMENT_RECONCILIATION_PENDING), à rapprocher (outbox de payment, consommateurs de cleaning ou billing)',
    );
  }
}
