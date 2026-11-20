import { type AppError, runWithContext } from '@ksp/platform';
import { type BillingEventPayloads } from '@ksp/contracts';
import {
  CUSTOMER_ID,
  ORGANIZATION_ID,
  ORGANIZATION_PROFILE,
  testWorld,
  type TestWorld,
} from './testing/fakes';
import { type IssueInvoiceInput } from './session-invoices.use-cases';
import { createUseCases } from './use-cases';

const SESSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5001';
const REQUEST_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001';
const DEBIT_ID = '0192f1c4-0000-7000-d000-000000000001';
const xof = (amount: number) => ({ amount, currency: 'XOF' });

/** Facture de séance d'un particulier telle que cleaning l'envoie au paiement (R-PP-06). */
function sessionRequest(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    idempotencyKey: `cleaning_session_invoice:${SESSION_ID}`,
    kind: 'session',
    customerId: CUSTOMER_ID,
    organizationId: '',
    sourceObject: { objectType: 'cleaning_session', objectId: SESSION_ID },
    requestNumber: 'DN-2026-000012',
    programNumber: 'PN-2026-000007',
    sessionRank: '3/15',
    placeLabel: 'Maison de Cocotomey',
    serviceDate: '2026-12-04',
    lines: [
      {
        label: 'Nettoyage — séance 3/15 du 4 décembre 2026',
        quantity: 1,
        unitPrice: xof(15_000),
        amount: xof(15_000),
        kind: 'session',
        serviceDate: '2026-12-04',
        sourceObjectId: SESSION_ID,
      },
    ],
    payment: {
      method: 'wallet',
      reference: DEBIT_ID,
      amount: xof(15_000),
      paidAt: '2026-12-04T17:30:00.000Z',
    },
    ...overrides,
  };
}

/** Reçu des frais de visite (R-FV-04) : sans rang ni date de séance. */
function visitFeeRequest(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return sessionRequest({
    idempotencyKey: `cleaning_request:${REQUEST_ID}:visit_fee`,
    kind: 'visit_fee',
    sourceObject: { objectType: 'cleaning_request', objectId: REQUEST_ID },
    programNumber: '',
    sessionRank: '',
    serviceDate: '',
    lines: [
      { label: 'Frais de visite', quantity: 1, unitPrice: xof(5_000), amount: xof(5_000), kind: 'visit_fee' },
    ],
    payment: {
      method: 'wallet',
      reference: DEBIT_ID,
      amount: xof(5_000),
      paidAt: '2026-12-02T10:00:00.000Z',
    },
    ...overrides,
  });
}

describe('facture de séance et reçu des frais de visite émis au paiement (ADR-055)', () => {
  let world: TestWorld;
  let useCases: ReturnType<typeof createUseCases>;

  beforeEach(() => {
    world = testWorld();
    useCases = createUseCases(world);
  });

  const issue = (input: IssueInvoiceInput, caller = 'cleaning') =>
    runWithContext({ correlationId: 'c-test', callerService: caller }, () =>
      useCases.issueInvoice.execute(input),
    );
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error: AppError) => error.code,
    );
  const field = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error: AppError) => `${error.code} ${String(error.details.field ?? '')}`,
    );
  const issued = () =>
    world.recorder.events
      .filter((e) => e.type === 'billing.invoice.issued')
      .map((e) => e.payload as BillingEventPayloads['billing.invoice.issued']);

  it('séance payée : facture « payée », numéro du compteur, paiement wallet, événement issued', async () => {
    const { invoice, created } = await issue(sessionRequest());
    expect(created).toBe(true);
    expect(invoice).toMatchObject({
      number: 'FAC-2026-000001',
      status: 'paid',
      kind: 'session',
      contractId: null,
      periodIndex: null,
      customerId: CUSTOMER_ID,
      organizationId: null,
      source: 'cleaning',
      total: 15_000,
      issuedAt: new Date('2026-12-05T08:00:00Z'),
      dueAt: new Date('2026-12-05T08:00:00Z'),
      paidAt: new Date('2026-12-04T17:30:00.000Z'),
      // Jour de la séance au Bénin : [4 décembre 00:00, 5 décembre 00:00).
      periodStart: new Date('2026-12-03T23:00:00.000Z'),
      periodEnd: new Date('2026-12-04T23:00:00.000Z'),
      // Émission : objet facturé, références lisibles, clé et empreinte du contenu.
      issuance: {
        issuer: 'cleaning',
        idempotencyKey: `cleaning_session_invoice:${SESSION_ID}`,
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        sourceObject: { objectType: 'cleaning_session', objectId: SESSION_ID },
        requestNumber: 'DN-2026-000012',
        programNumber: 'PN-2026-000007',
        sessionRank: '3/15',
        placeLabel: 'Maison de Cocotomey',
        serviceDate: '2026-12-04',
        createdAt: new Date('2026-12-05T08:00:00Z'),
      },
    });
    expect(invoice.lines).toEqual([
      {
        label: 'Nettoyage — séance 3/15 du 4 décembre 2026',
        quantity: 1,
        unitPrice: 15_000,
        amount: 15_000,
        kind: 'session',
        serviceDate: '2026-12-04',
        sourceObjectId: SESSION_ID,
      },
    ]);
    expect(invoice.payments).toEqual([
      expect.objectContaining({
        amount: 15_000,
        method: 'wallet',
        reference: DEBIT_ID,
        recordedBy: 'system',
        recordedAt: new Date('2026-12-04T17:30:00.000Z'),
      }),
    ]);
    expect(issued()).toEqual([
      {
        invoiceId: invoice.id,
        invoiceNumber: 'FAC-2026-000001',
        customerId: CUSTOMER_ID,
        organizationId: null,
        source: 'cleaning',
        total: xof(15_000),
        periodStart: '2026-12-03T23:00:00.000Z',
        periodEnd: '2026-12-04T23:00:00.000Z',
        issuedAt: '2026-12-05T08:00:00.000Z',
        dueAt: '2026-12-05T08:00:00.000Z',
        kind: 'session',
        status: 'paid',
      },
    ]);
    // Facture v2 : l'événement part en version 2, sans contrat (RV-98).
    const versions = world.recorder.events
      .filter((e) => e.type === 'billing.invoice.issued')
      .map((e) => e.version);
    expect(versions).toEqual([2]);
  });

  it('rejeu de la même clé : même facture, created false, ni numéro ni événement de plus', async () => {
    const first = await issue(sessionRequest());
    world.clock.current = new Date('2026-12-05T09:00:00Z');
    const again = await issue(sessionRequest());
    expect(again).toEqual({ invoice: first.invoice, created: false });
    expect(world.invoices.invoices.size).toBe(1);
    expect(issued()).toHaveLength(1);
    // Une autre séance prend le numéro suivant, sans trou.
    const next = await issue(
      sessionRequest({
        idempotencyKey: 'cleaning_session_invoice:0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5002',
        sourceObject: { objectType: 'cleaning_session', objectId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5002' },
        sessionRank: '4/15',
      }),
    );
    expect(next.invoice.number).toBe('FAC-2026-000002');
  });

  it('même clé, autre contenu : BILLING_IDEMPOTENCY_KEY_REUSED', async () => {
    await issue(sessionRequest());
    const changed = sessionRequest({
      lines: [{ label: 'Séance', quantity: 1, unitPrice: xof(20_000), amount: xof(20_000), kind: 'session' }],
      payment: {
        method: 'wallet',
        reference: DEBIT_ID,
        amount: xof(20_000),
        paidAt: '2026-12-04T17:30:00.000Z',
      },
    });
    expect(await code(issue(changed))).toBe('BILLING_IDEMPOTENCY_KEY_REUSED');
    expect(await code(issue(sessionRequest({ sessionRank: '4/15' })))).toBe('BILLING_IDEMPOTENCY_KEY_REUSED');
    const otherPaidAt = { ...sessionRequest().payment!, paidAt: '2026-12-04T18:00:00.000Z' };
    expect(await code(issue(sessionRequest({ payment: otherPaidAt })))).toBe(
      'BILLING_IDEMPOTENCY_KEY_REUSED',
    );
    expect(await code(issue(visitFeeRequest({ idempotencyKey: sessionRequest().idempotencyKey })))).toBe(
      'BILLING_IDEMPOTENCY_KEY_REUSED',
    );
    expect(world.invoices.invoices.size).toBe(1);
  });

  it('total incohérent : montant payé différent, ligne mal calculée, total négatif', async () => {
    const paid = (amount: number) => ({
      method: 'wallet',
      reference: DEBIT_ID,
      amount: xof(amount),
      paidAt: '',
    });
    expect(await field(issue(sessionRequest({ payment: paid(14_000) })))).toBe(
      'BILLING_VALIDATION_FAILED payment.amount',
    );
    expect(
      await field(
        issue(
          sessionRequest({
            lines: [{ label: 'Séance', quantity: 2, unitPrice: xof(15_000), amount: xof(15_000) }],
          }),
        ),
      ),
    ).toBe('BILLING_VALIDATION_FAILED lines[0].amount');
    expect(
      await field(
        issue(
          sessionRequest({
            lines: [
              { label: 'Séance', quantity: 1, unitPrice: xof(5_000), amount: xof(5_000), kind: 'session' },
              {
                label: 'Frais de visite déduits',
                quantity: 1,
                unitPrice: xof(-6_000),
                amount: xof(-6_000),
                kind: 'visit_fee_deduction',
              },
            ],
            payment: paid(-1_000),
          }),
        ),
      ),
    ).toBe('BILLING_VALIDATION_FAILED lines');
    expect(world.invoices.invoices.size).toBe(0);
    expect(world.recorder.events).toEqual([]);
  });

  it('séance d’une entreprise refusée (facture mensuelle) ; frais de visite d’une entreprise acceptés, avec en-tête', async () => {
    expect(await field(issue(sessionRequest({ organizationId: ORGANIZATION_ID })))).toBe(
      'BILLING_VALIDATION_FAILED organizationId',
    );
    const { invoice } = await issue(visitFeeRequest({ organizationId: ORGANIZATION_ID }));
    expect(invoice).toMatchObject({
      kind: 'visit_fee',
      organizationId: ORGANIZATION_ID,
      issuance: { sessionRank: null, serviceDate: null, programNumber: null },
      // Jour du paiement au Bénin.
      periodStart: new Date('2026-12-01T23:00:00.000Z'),
      periodEnd: new Date('2026-12-02T23:00:00.000Z'),
    });
    const { id: _id, ...header } = ORGANIZATION_PROFILE;
    expect(invoice.organization).toEqual(header);
    expect(issued()[0]).toMatchObject({
      kind: 'visit_fee',
      organizationId: ORGANIZATION_ID,
    });
  });

  it('frais de visite déduits : ligne négative « visit_fee_deduction » seulement', async () => {
    const lines = [
      { label: 'Séance 1/15', quantity: 1, unitPrice: xof(15_000), amount: xof(15_000), kind: 'session' },
      {
        label: 'Frais de visite déduits',
        quantity: 1,
        unitPrice: xof(-5_000),
        amount: xof(-5_000),
        kind: 'visit_fee_deduction',
      },
    ];
    const payment = { method: 'wallet', reference: DEBIT_ID, amount: xof(10_000), paidAt: '' };
    const { invoice } = await issue(sessionRequest({ lines, payment }));
    expect(invoice).toMatchObject({ total: 10_000, paidAt: new Date('2026-12-05T08:00:00Z') });
    expect(invoice.lines[1]).toMatchObject({ amount: -5_000, kind: 'visit_fee_deduction' });

    const other = (patch: object) =>
      field(
        issue(
          sessionRequest({
            idempotencyKey: 'cleaning_session_invoice:autre-seance',
            lines: [lines[0]!, { ...lines[1]!, ...patch }],
            payment,
          }),
        ),
      );
    // Ligne négative d'une autre nature, ou déduction positive : refusées.
    expect(await other({ kind: 'adjustment' })).toBe('BILLING_VALIDATION_FAILED lines[1].amount');
    expect(await other({ kind: undefined })).toBe('BILLING_VALIDATION_FAILED lines[1].amount');
    expect(
      await field(
        issue(
          sessionRequest({
            idempotencyKey: 'cleaning_session_invoice:deduction-positive',
            lines: [lines[0]!, { ...lines[1]!, unitPrice: xof(5_000), amount: xof(5_000) }],
            payment: { ...payment, amount: xof(20_000) },
          }),
        ),
      ),
    ).toBe('BILLING_VALIDATION_FAILED lines[1].amount');

    // Séance entièrement couverte par la déduction : total 0, aucun paiement enregistré.
    const covered = await issue(
      sessionRequest({
        idempotencyKey: 'cleaning_session_invoice:couverte',
        lines: [lines[0]!, { ...lines[1]!, unitPrice: xof(-15_000), amount: xof(-15_000) }],
        payment: { method: 'wallet', reference: '', amount: xof(0), paidAt: '' },
      }),
    );
    expect(covered.invoice).toMatchObject({ status: 'paid', total: 0, payments: [] });
  });

  it('année du numéro : celle du paiement au Bénin', async () => {
    // 31 décembre 23:30 UTC = 1er janvier 00:30 au Bénin.
    const payment = {
      method: 'wallet',
      reference: DEBIT_ID,
      amount: xof(15_000),
      paidAt: '2026-12-31T23:30:00.000Z',
    };
    const { invoice } = await issue(sessionRequest({ serviceDate: '2026-12-31', payment }));
    expect(invoice.number).toBe('FAC-2027-000001');
  });

  it('requête invalide : clé, nature, lignes, paiement, champs propres à la séance', async () => {
    const bad = (overrides: Partial<IssueInvoiceInput>) => field(issue(sessionRequest(overrides)));
    expect(await bad({ idempotencyKey: 'court' })).toBe('BILLING_VALIDATION_FAILED idempotencyKey');
    expect(await bad({ idempotencyKey: 'cle avec espaces' })).toBe(
      'BILLING_VALIDATION_FAILED idempotencyKey',
    );
    expect(await bad({ idempotencyKey: 'k'.repeat(151) })).toBe('BILLING_VALIDATION_FAILED idempotencyKey');
    expect(await bad({ kind: 'monthly' })).toBe('BILLING_VALIDATION_FAILED kind');
    expect(await bad({ customerId: 'x' })).toBe('BILLING_VALIDATION_FAILED customerId');
    expect(await bad({ sourceObject: undefined })).toBe('BILLING_VALIDATION_FAILED sourceObject');
    expect(await bad({ sourceObject: { objectType: 'cleaning_request', objectId: SESSION_ID } })).toBe(
      'BILLING_VALIDATION_FAILED sourceObject.objectType',
    );
    expect(await bad({ lines: [] })).toBe('BILLING_VALIDATION_FAILED lines');
    const line = sessionRequest().lines[0]!;
    expect(await bad({ lines: Array.from({ length: 51 }, () => line) })).toBe(
      'BILLING_VALIDATION_FAILED lines',
    );
    expect(await bad({ lines: [{ ...line, kind: 'remise' }] })).toBe(
      'BILLING_VALIDATION_FAILED lines[0].kind',
    );
    expect(await bad({ payment: undefined })).toBe('BILLING_VALIDATION_FAILED payment');
    expect(await bad({ payment: { ...sessionRequest().payment!, method: 'cash' } })).toBe(
      'BILLING_VALIDATION_FAILED payment.method',
    );
    expect(await bad({ payment: { ...sessionRequest().payment!, reference: '' } })).toBe(
      'BILLING_VALIDATION_FAILED payment.reference',
    );
    expect(await bad({ sessionRank: '' })).toBe('BILLING_VALIDATION_FAILED sessionRank');
    expect(await bad({ sessionRank: '16/15' })).toBe('BILLING_VALIDATION_FAILED sessionRank');
    expect(await bad({ serviceDate: '2026-02-30' })).toBe('BILLING_VALIDATION_FAILED serviceDate');
    expect(await field(issue(visitFeeRequest({ sessionRank: '1/15' })))).toBe(
      'BILLING_VALIDATION_FAILED sessionRank',
    );
    expect(world.invoices.invoices.size).toBe(0);
  });

  it('réservé à cleaning : un autre service est refusé', async () => {
    expect(await code(issue(sessionRequest(), 'payment'))).toBe('BILLING_CALLER_FORBIDDEN');
    expect(world.invoices.invoices.size).toBe(0);
  });
});
