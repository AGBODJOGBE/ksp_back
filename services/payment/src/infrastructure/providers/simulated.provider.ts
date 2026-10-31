import { randomBytes } from 'node:crypto';
import {
  type Checkout,
  type CheckoutRequest,
  type PaymentProvider,
  type ProviderNotification,
  type ProviderTransaction,
} from '../../application/ports';
import { PaymentErrors } from '../../application/shared/errors';
import { type ProviderStatus } from '../../domain/payment-intent';

/**
 * Prestataire simulé (développement local et tests, ADR-031) : même contrat que FedaPay, sans
 * réseau. La page de paiement est celle du portail (`checkoutBaseUrl?paymentId=…`), qui appelle la
 * route de simulation ; aucune notification n'est jamais envoyée (toute notification est refusée).
 * Les transactions vivent en mémoire : un redémarrage du service les oublie (le paiement expire).
 * Interdit en production (configuration).
 */
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated' as const;
  private readonly transactions = new Map<string, ProviderTransaction>();

  constructor(private readonly checkoutBaseUrl: string) {}

  async createCheckout(request: CheckoutRequest): Promise<Checkout> {
    const transactionId = `sim_${randomBytes(8).toString('hex')}`;
    const reference = `SIM-${transactionId.slice(4, 12).toUpperCase()}`;
    this.transactions.set(transactionId, {
      transactionId,
      paymentId: request.paymentId,
      reference,
      status: 'pending',
      amount: request.amount,
      currency: request.currency,
    });
    const url = new URL(this.checkoutBaseUrl);
    url.searchParams.set('paymentId', request.paymentId);
    return { transactionId, reference, checkoutUrl: url.toString() };
  }

  async getTransaction(transactionId: string): Promise<ProviderTransaction> {
    const transaction = this.transactions.get(transactionId);
    // Transaction oubliée (redémarrage) : toujours en attente ; le paiement finira par expirer.
    return transaction
      ? { ...transaction }
      : { transactionId, paymentId: null, reference: null, status: 'pending', amount: 0, currency: 'XOF' };
  }

  verifyNotification(): ProviderNotification {
    throw PaymentErrors.signatureInvalid();
  }

  async cancelTransaction(transactionId: string): Promise<boolean> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.status !== 'pending') return false;
    this.transactions.set(transactionId, { ...transaction, status: 'canceled' });
    return true;
  }

  async settle(transactionId: string, outcome: 'succeeded' | 'failed'): Promise<void> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) throw PaymentErrors.notFound();
    if (transaction.status !== 'pending') return;
    const status: ProviderStatus = outcome === 'succeeded' ? 'approved' : 'declined';
    this.transactions.set(transactionId, { ...transaction, status });
  }
}
