import { type AppError } from '@ksp/platform';
import { type PaymentProvider } from '../../application/ports';
import { SimulatedProvider } from './simulated.provider';
import { FedapayProvider } from './fedapay.provider';
import { signatureHeader, verifySignature } from './webhook-signature';

const SECRET = 'wh_sandbox_test_secret';
const NOW = new Date('2026-11-02T09:00:00.000Z');
const T = Math.floor(NOW.getTime() / 1000);
const BODY = Buffer.from(JSON.stringify({ id: 77, name: 'transaction.approved', entity: { id: 104571 } }));

describe('signature des notifications FedaPay', () => {
  it('accepte la signature du corps exact, récente', () => {
    expect(verifySignature(BODY, signatureHeader(BODY, T, SECRET), SECRET, NOW)).toBe(true);
  });

  it('refuse un corps modifié, un autre secret, un en-tête vide ou mal formé', () => {
    const header = signatureHeader(BODY, T, SECRET);
    expect(verifySignature(Buffer.from(`${BODY.toString()} `), header, SECRET, NOW)).toBe(false);
    expect(verifySignature(BODY, signatureHeader(BODY, T, 'autre'), SECRET, NOW)).toBe(false);
    expect(verifySignature(BODY, '', SECRET, NOW)).toBe(false);
    expect(verifySignature(BODY, 't=abc,s=zz', SECRET, NOW)).toBe(false);
    expect(verifySignature(BODY, header, '', NOW)).toBe(false);
  });

  it('refuse une notification trop ancienne ou datée du futur (rejeu), au-delà de 5 minutes', () => {
    expect(verifySignature(BODY, signatureHeader(BODY, T - 301, SECRET), SECRET, NOW)).toBe(false);
    expect(verifySignature(BODY, signatureHeader(BODY, T + 301, SECRET), SECRET, NOW)).toBe(false);
    expect(verifySignature(BODY, signatureHeader(BODY, T - 299, SECRET), SECRET, NOW)).toBe(true);
  });
});

describe('adaptateur FedaPay', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  const provider = new FedapayProvider({
    apiUrl: 'https://sandbox-api.fedapay.com/v1',
    secretKey: 'sk_sandbox_secret',
    webhookSecret: SECRET,
    fetch: fakeFetch,
  });

  beforeEach(() => {
    calls.length = 0;
    responses.length = 0;
  });

  it('crée la transaction (sans donnée du payeur) puis le jeton de la page de paiement', async () => {
    responses.push(
      {
        status: 200,
        body: { 'v1/transaction': { id: 104571, reference: 'trx_Ab12', status: 'pending', amount: 15000 } },
      },
      { status: 200, body: { token: 'tok', url: 'https://process.fedapay.com/tok' } },
    );
    const checkout = await provider.createCheckout({
      paymentId: '0192f1c4-0000-7000-8000-000000000001',
      amount: 15000,
      currency: 'XOF',
      description: 'KSP Nettoyage - Acompte',
      returnUrl: 'https://ksp.bj/mon-espace/paiements/0192f1c4-0000-7000-8000-000000000001',
    });
    expect(checkout).toEqual({
      transactionId: '104571',
      reference: 'trx_Ab12',
      checkoutUrl: 'https://process.fedapay.com/tok',
    });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST https://sandbox-api.fedapay.com/v1/transactions',
      'POST https://sandbox-api.fedapay.com/v1/transactions/104571/token',
    ]);
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk_sandbox_secret',
    );
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toEqual({
      description: 'KSP Nettoyage - Acompte',
      amount: 15000,
      currency: { iso: 'XOF' },
      callback_url: 'https://ksp.bj/mon-espace/paiements/0192f1c4-0000-7000-8000-000000000001',
      custom_metadata: { payment_id: '0192f1c4-0000-7000-8000-000000000001' },
    });
  });

  it('relit la transaction : statuts traduits (transferred = réglé)', async () => {
    responses.push(
      {
        status: 200,
        body: { 'v1/transaction': { id: 1, reference: 'r', status: 'transferred', amount: 15000 } },
      },
      {
        status: 200,
        body: { 'v1/transaction': { id: 1, reference: 'r', status: 'canceled', amount: 15000 } },
      },
      {
        status: 200,
        body: { 'v1/transaction': { id: 1, reference: 'r', status: 'bizarre', amount: 15000 } },
      },
    );
    expect((await provider.getTransaction('1')).status).toBe('approved');
    expect((await provider.getTransaction('1')).status).toBe('canceled');
    expect((await provider.getTransaction('1')).status).toBe('unknown');
  });

  it('erreur HTTP ou réponse inattendue : PAYMENT_PROVIDER_UNAVAILABLE, sans la clé dans le message', async () => {
    responses.push({ status: 401, body: { message: 'Invalid key' } });
    const error = (await provider.getTransaction('1').catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(error.message).not.toContain('sk_sandbox');
    responses.push({ status: 200, body: { unexpected: true } });
    expect(((await provider.getTransaction('1').catch((e: unknown) => e)) as AppError).code).toBe(
      'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('notification : signature vérifiée, événement et transaction extraits', () => {
    const now = new Date();
    const header = signatureHeader(BODY, Math.floor(now.getTime() / 1000), SECRET);
    expect(provider.verifyNotification(BODY, header, now)).toEqual({
      eventName: 'transaction.approved',
      eventId: '77',
      transactionId: '104571',
    });
    expect(() => provider.verifyNotification(BODY, 't=1,s=00', now)).toThrow(
      expect.objectContaining({ code: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID' }),
    );
  });
});

describe('prestataire simulé', () => {
  it('page de paiement du portail, réglée par la simulation, aucune notification acceptée', async () => {
    const provider = new SimulatedProvider('http://localhost:3010/mon-espace/paiements/simulation');
    const checkout = await provider.createCheckout({
      paymentId: 'p-1',
      amount: 15000,
      currency: 'XOF',
      description: 'KSP Nettoyage - Acompte',
      returnUrl: 'http://localhost:3010/mon-espace/paiements/p-1',
    });
    expect(checkout.checkoutUrl).toBe('http://localhost:3010/mon-espace/paiements/simulation?paymentId=p-1');
    expect((await provider.getTransaction(checkout.transactionId)).status).toBe('pending');
    await provider.settle(checkout.transactionId, 'succeeded');
    expect(await provider.getTransaction(checkout.transactionId)).toMatchObject({
      status: 'approved',
      amount: 15000,
    });
    await provider.settle(checkout.transactionId, 'failed');
    expect((await provider.getTransaction(checkout.transactionId)).status).toBe('approved');
    expect(() => provider.verifyNotification()).toThrow(
      expect.objectContaining({ code: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID' }),
    );
  });
});

describe('adaptateur FedaPay : devise et paiement de la transaction relue', () => {
  const answer = (transaction: Record<string, unknown>) =>
    (async () =>
      new Response(
        JSON.stringify({ 'v1/transaction': { id: 1, status: 'approved', amount: 15000, ...transaction } }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;
  const read = (transaction: Record<string, unknown>, xofCurrencyId?: string) =>
    new FedapayProvider({
      apiUrl: 'https://sandbox-api.fedapay.com/v1',
      secretKey: 'sk',
      webhookSecret: SECRET,
      fetch: answer(transaction),
      ...(xofCurrencyId ? { xofCurrencyId } : {}),
    }).getTransaction('1');

  it('devise ISO lue ; currency_id comparé à l’identifiant XOF configuré', async () => {
    expect((await read({ currency: { iso: 'xof' } })).currency).toBe('XOF');
    expect((await read({ currency_id: 1 }, '1')).currency).toBe('XOF');
    expect((await read({ currency: { iso: 'XOF' }, currency_id: 1 }, '1')).currency).toBe('XOF');
  });

  it('jamais de XOF par défaut : devise absente, inconnue ou contradictoire → UNKNOWN', async () => {
    expect((await read({})).currency).toBe('UNKNOWN');
    expect((await read({ currency_id: 1 })).currency).toBe('UNKNOWN');
    expect((await read({ currency_id: 2 }, '1')).currency).toBe('UNKNOWN');
    expect((await read({ currency: { iso: 'XOF' }, currency_id: 2 }, '1')).currency).toBe('UNKNOWN');
    expect((await read({ currency: { iso: 'EUR' } })).currency).toBe('EUR');
  });

  it('paiement KSP inscrit à la création relu dans custom_metadata.payment_id', async () => {
    expect((await read({ custom_metadata: { payment_id: 'p-1' } })).paymentId).toBe('p-1');
    expect((await read({})).paymentId).toBeNull();
  });

  it('aucune annulation de transaction : non documentée par FedaPay (ADR-031)', () => {
    const provider: PaymentProvider = new FedapayProvider({
      apiUrl: 'x',
      secretKey: 'sk',
      webhookSecret: SECRET,
    });
    expect(provider.cancelTransaction).toBeUndefined();
  });
});

describe('prestataire simulé : annulation', () => {
  it('annule une transaction en attente ; une transaction réglée ne l’est plus', async () => {
    const provider = new SimulatedProvider('http://localhost:3010/mon-espace/paiements/simulation');
    const request = {
      paymentId: 'p-1',
      amount: 15000,
      currency: 'XOF' as const,
      description: 'KSP',
      returnUrl: 'http://localhost:3010/mon-espace/paiements/p-1',
    };
    const first = await provider.createCheckout(request);
    expect(await provider.cancelTransaction(first.transactionId)).toBe(true);
    expect(await provider.getTransaction(first.transactionId)).toMatchObject({
      status: 'canceled',
      paymentId: 'p-1',
    });
    const second = await provider.createCheckout(request);
    await provider.settle(second.transactionId, 'succeeded');
    expect(await provider.cancelTransaction(second.transactionId)).toBe(false);
  });
});
