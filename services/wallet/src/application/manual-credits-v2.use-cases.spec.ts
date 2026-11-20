import { type AppError } from '@ksp/platform';
import { asStaff, makeDeps, ORGANIZATION_ID, STAFF_ID } from './testing/fakes';
import { createUseCases } from './use-cases';

const ORG = { type: 'organization', id: ORGANIZATION_ID };
const OTHER_STAFF_ID = '0192f1c4-0000-7000-8000-00000000d002';
const INVOICE_ID = '0192f1c4-0000-7000-8000-00000000e201';
const xof = (amount: number) => ({ amount, currency: 'XOF' });

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('crédits manuels v2 : espèces, virement, rejet (R-WL-02, R-PE-04)', () => {
  let setup: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;

  beforeEach(() => {
    setup = makeDeps();
    useCases = createUseCases(setup.deps);
  });

  const credit = (overrides: Record<string, unknown> = {}, userId = STAFF_ID) =>
    asStaff(
      () =>
        useCases.creditPrepaidWallet.execute({
          idempotencyKey: 'cash-key-0001',
          holder: ORG,
          kind: 'cash_top_up',
          amount: xof(2000),
          reason: 'Recharge en espèces au guichet de Cotonou',
          paymentId: '',
          receiptReference: 'REC-2026-0042',
          ...overrides,
        } as never),
      'finance_officer',
      true,
      userId,
    );
  const approve = (requestId: string, userId = OTHER_STAFF_ID) =>
    asStaff(() => useCases.approveManualCredit.execute(requestId), 'finance_officer', true, userId);
  const reject = (requestId: string, reason = 'Somme non retrouvée en caisse', userId = OTHER_STAFF_ID) =>
    asStaff(
      () => useCases.rejectManualCredit.execute({ requestId, reason }),
      'finance_officer',
      true,
      userId,
    );

  it('espèces : toujours une demande à valider, quel que soit le montant ; reçu gardé', async () => {
    const first = await credit();
    expect(first).toMatchObject({
      transaction: null,
      created: true,
      pendingRequest: {
        kind: 'cash_top_up',
        status: 'pending_approval',
        receiptReference: 'REC-2026-0042',
        forObject: null,
      },
    });
    expect(setup.store.transactions.size).toBe(0);
    const approved = await approve(first.pendingRequest!.id);
    expect(approved).toMatchObject({
      created: true,
      transaction: { kind: 'top_up', amount: 2000, actorId: STAFF_ID },
      wallet: { balance: 2000 },
    });
    expect(setup.store.balances.get('ksp:prepaid_funds')).toBe(2000);
    expect(setup.store.events).toEqual([
      {
        type: 'wallet.prepaid.credited',
        version: 2,
        payload: expect.objectContaining({ kind: 'top_up', topUpChannel: 'cash', origin: 'finance' }),
      },
    ]);
  });

  it('virement d’une organisation avec la facture à régler : forObject repris dans l’événement', async () => {
    const forObject = { service: 'billing', objectType: 'billing_invoice', objectId: INVOICE_ID, part: '' };
    const first = await credit({
      idempotencyKey: 'bank-key-0001',
      kind: 'bank_transfer_top_up',
      amount: xof(150_000),
      receiptReference: 'VIR-BOA-778812',
      forObject,
    });
    expect(first.pendingRequest).toMatchObject({
      forObject: { service: 'billing', objectType: 'billing_invoice', objectId: INVOICE_ID, part: null },
    });
    await approve(first.pendingRequest!.id);
    expect(setup.store.events[0]!.payload).toMatchObject({
      topUpChannel: 'bank_transfer',
      forObject: { service: 'billing', objectType: 'billing_invoice', objectId: INVOICE_ID, part: null },
    });
  });

  it('contrôles : reçu obligatoire pour espèces et virement, refusé ailleurs ; objet bien formé', async () => {
    const field = async (overrides: Record<string, unknown>) =>
      ((await rejection(credit(overrides))).details as { field: string }).field;
    expect(await field({ receiptReference: '' })).toBe('receiptReference');
    expect(await field({ receiptReference: 'x'.repeat(101) })).toBe('receiptReference');
    expect(await field({ kind: 'refund', reason: 'Geste commercial pour un retard' })).toBe(
      'receiptReference',
    );
    expect(await field({ paymentId: INVOICE_ID })).toBe('paymentId');
    expect(
      await field({
        forObject: { service: 'Billing', objectType: 'billing_invoice', objectId: INVOICE_ID, part: '' },
      }),
    ).toBe('forObject.service');
    expect(
      await field({
        kind: 'refund',
        receiptReference: undefined,
        reason: 'Geste commercial pour un retard',
        forObject: { service: 'billing', objectType: 'billing_invoice', objectId: INVOICE_ID, part: '' },
      }),
    ).toBe('forObject');
  });

  it('rejet motivé d’une demande en attente : rien n’est crédité ; plus validable ensuite', async () => {
    const first = await credit();
    const rejected = await reject(first.pendingRequest!.id);
    expect(rejected.request).toMatchObject({
      status: 'rejected',
      rejectedBy: OTHER_STAFF_ID,
      rejectionReason: 'Somme non retrouvée en caisse',
    });
    expect((await rejection(approve(first.pendingRequest!.id))).code).toBe(
      'WALLET_CREDIT_REQUEST_NOT_PENDING',
    );
    expect((await rejection(reject(first.pendingRequest!.id))).code).toBe(
      'WALLET_CREDIT_REQUEST_NOT_PENDING',
    );
    expect(setup.store.transactions.size).toBe(0);
    // La demande rejouée rend la demande rejetée, sans crédit.
    expect(await credit()).toMatchObject({
      created: false,
      transaction: null,
      pendingRequest: { status: 'rejected' },
    });
    const listed = await asStaff(() =>
      useCases.listManualCreditRequests.execute({ page: { limit: 20, cursor: null }, status: 'rejected' }),
    );
    expect(listed.items).toHaveLength(1);
  });

  it('l’auteur peut annuler sa propre demande ; demande validée ou inconnue non rejetable', async () => {
    const own = await credit();
    expect((await reject(own.pendingRequest!.id, 'Saisie en double', STAFF_ID)).request.status).toBe(
      'rejected',
    );
    const other = await credit({ idempotencyKey: 'cash-key-0002' });
    await approve(other.pendingRequest!.id);
    expect((await rejection(reject(other.pendingRequest!.id))).code).toBe(
      'WALLET_CREDIT_REQUEST_NOT_PENDING',
    );
    expect((await rejection(reject(INVOICE_ID))).code).toBe('WALLET_CREDIT_REQUEST_NOT_FOUND');
    expect(((await rejection(reject(own.pendingRequest!.id, ''))).details as { field: string }).field).toBe(
      'reason',
    );
  });
});
