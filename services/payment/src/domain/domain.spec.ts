import { invoiceAmount, missionAmount } from './amount-due';
import {
  applyProviderStatus,
  expire,
  flagAmountMismatch,
  type PaymentIntent,
  supersede,
} from './payment-intent';

const NOW = new Date('2026-11-02T09:00:00.000Z');
const USER = 'u1';

const intent = (overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'p1',
  subject: { type: 'cleaning_mission', id: 'm1', part: 'deposit', reference: null },
  amount: 15000,
  customerId: USER,
  organizationId: null,
  status: 'pending',
  provider: 'fedapay',
  providerTransactionId: '1',
  providerReference: 'r',
  checkoutUrl: 'https://process.fedapay.com/t',
  idempotencyKey: 'k',
  failureReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 30 * 60_000),
  completedAt: null,
  lastCheckedAt: null,
  version: 0,
  ...overrides,
});

describe('machine à états du paiement', () => {
  it('approuvé : réussi ; une seconde approbation ne change rien', () => {
    const transition = applyProviderStatus(intent(), 'approved', NOW);
    expect(transition).toMatchObject({
      kind: 'succeeded',
      intent: { status: 'succeeded', completedAt: NOW },
    });
    expect(applyProviderStatus(transition!.intent, 'approved', NOW)).toBeNull();
  });

  it('refusé, abandonné, expiré chez le prestataire : non abouti, avec sa raison', () => {
    expect(applyProviderStatus(intent(), 'declined', NOW)?.intent).toMatchObject({
      status: 'failed',
      failureReason: 'declined',
    });
    expect(applyProviderStatus(intent(), 'canceled', NOW)?.intent.status).toBe('cancelled');
    expect(applyProviderStatus(intent(), 'expired', NOW)?.intent.status).toBe('expired');
  });

  it('en attente, remboursé ou inconnu : aucun changement', () => {
    for (const status of ['pending', 'refunded', 'unknown'] as const) {
      expect(applyProviderStatus(intent(), status, NOW)).toBeNull();
    }
  });

  it('une réussite l’emporte sur un échec ou une expiration ; l’inverse jamais', () => {
    expect(applyProviderStatus(intent({ status: 'expired' }), 'approved', NOW)?.kind).toBe('succeeded');
    expect(applyProviderStatus(intent({ status: 'succeeded' }), 'declined', NOW)).toBeNull();
  });

  it('expiration locale seulement au-delà du délai', () => {
    expect(expire(intent(), NOW)).toBeNull();
    expect(expire(intent(), new Date(NOW.getTime() + 31 * 60_000))?.intent.status).toBe('expired');
  });
});

describe('montant dû', () => {
  const mission = {
    missionId: 'm1',
    customerId: USER,
    organizationId: null,
    status: 'scheduled',
    depositDue: 15000,
    remainingDue: 50000,
  };
  const payer = { userId: USER, organizationId: null };

  it('mission : acompte ou reste dû, lus tels quels', () => {
    expect(missionAmount(mission, 'deposit', payer)).toEqual({ amount: 15000 });
    expect(missionAmount(mission, 'balance', payer)).toEqual({ amount: 50000 });
  });

  it('mission : autre client, entreprise, annulée, rien à payer', () => {
    expect(missionAmount(mission, 'deposit', { userId: 'u2', organizationId: null })).toEqual({
      refusal: 'not_found',
    });
    expect(missionAmount({ ...mission, organizationId: 'o1' }, 'deposit', payer)).toEqual({
      refusal: 'via_invoice',
    });
    expect(missionAmount({ ...mission, status: 'cancelled' }, 'deposit', payer)).toEqual({
      refusal: 'not_payable',
    });
    expect(missionAmount({ ...mission, depositDue: 0 }, 'deposit', payer)).toEqual({
      refusal: 'nothing_due',
    });
  });

  it('facture : même périmètre que « Mes factures »', () => {
    const invoice = {
      invoiceId: 'i1',
      number: 'FAC-2026-000001',
      customerId: USER,
      organizationId: 'o1',
      status: 'overdue',
      balance: 1000,
    };
    expect(invoiceAmount(invoice, { userId: 'u2', organizationId: 'o1' })).toEqual({ amount: 1000 });
    expect(invoiceAmount(invoice, payer)).toEqual({ refusal: 'not_found' });
    expect(invoiceAmount({ ...invoice, organizationId: null }, payer)).toEqual({ amount: 1000 });
    expect(
      invoiceAmount({ ...invoice, status: 'paid', balance: 0 }, { userId: USER, organizationId: 'o1' }),
    ).toEqual({
      refusal: 'nothing_due',
    });
  });
});

describe('écart de montant et paiement remplacé', () => {
  it('montant approuvé différent : amount_mismatch, jamais depuis une réussite, jamais expiré ni réglé ensuite', () => {
    const flagged = flagAmountMismatch(intent(), NOW)!;
    expect(flagged).toMatchObject({ kind: 'amount_mismatch', intent: { status: 'amount_mismatch' } });
    expect(flagAmountMismatch(intent({ status: 'succeeded' }), NOW)).toBeNull();
    expect(expire(flagged.intent, new Date(NOW.getTime() + 3_600_000))).toBeNull();
    expect(applyProviderStatus(flagged.intent, 'approved', NOW)).toBeNull();
  });

  it('paiement en attente remplacé : annulé ; un paiement terminé ne l’est pas', () => {
    expect(supersede(intent(), NOW)?.intent).toMatchObject({
      status: 'cancelled',
      failureReason: 'cancelled',
    });
    expect(supersede(intent({ status: 'succeeded' }), NOW)).toBeNull();
  });
});
