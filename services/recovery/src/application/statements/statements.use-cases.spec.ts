import { type RecoveryCaseRecord } from '../cases/ports';
import { asOtherCreditor } from '../testing/case-scenarios';
import { asCreditor, CREDITOR_ID, rejection } from '../testing/fakes';
import { activeCase, debtorScope, moneyWorld, type MoneyWorld, payLink } from '../testing/money-scenarios';
import { type MemoryStatementStore } from '../testing/statement-fakes';

const INVOICE_ID = '0192f1c4-0000-7000-8000-0000000fc001';
/** 1er décembre 2026 à 00 h 30, heure du Bénin : novembre est écoulé. */
const DECEMBER_FIRST = new Date('2026-11-30T23:30:00.000Z');

describe('relevés mensuels (R-CO-05)', () => {
  let world: MoneyWorld;
  let record: RecoveryCaseRecord;
  let store: MemoryStatementStore;

  beforeEach(async () => {
    world = moneyWorld();
    store = world.deps.statements as MemoryStatementStore;
    record = await activeCase(world);
    await world.useCases.createDebtorPayment.execute({
      ...debtorScope(record),
      idempotencyKey: 'pay-key-0001',
      amount: 100_000,
      settlementId: '',
    });
    await payLink(world, record);
  });

  const invoice = (eventId = '0192f1c4-0000-7000-8000-0000000fe001') =>
    world.useCases.recordCommissionInvoice.execute({
      eventId,
      invoiceId: INVOICE_ID,
      invoiceNumber: 'FCR-2026-000001',
      creditor: { type: 'user', id: CREDITOR_ID },
      period: '2026-11',
      issuedAt: '2026-11-30T23:00:00.000Z',
    });
  const list = (input: { period?: string; caseId?: string } = {}) =>
    world.useCases.listMyStatements.execute({ period: input.period ?? '', caseId: input.caseId ?? '' });

  it('rien avant la fin du mois ; dès le 1er, un relevé par dossier crédité, avec son PDF', async () => {
    expect(await world.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 0, failed: 0 });

    world.deps.clock.current = DECEMBER_FIRST;
    expect(await world.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 1, failed: 0 });
    const [statement] = [...store.statements.values()];
    expect(statement).toMatchObject({
      caseId: record.id,
      caseNumber: record.number,
      creditor: { type: 'user', id: CREDITOR_ID },
      period: '2026-11',
      collected: 100_000,
      commission: 10_000,
      costs: 0,
      remitted: 90_000,
      invoiceId: null,
      issuedAt: DECEMBER_FIRST,
    });
    const document = world.documents.generated.get(`recovery:statement:${record.id}:2026-11`)!;
    expect(statement!.documentId).toBe(document.id);
    expect(document.variables).toEqual({
      caseReference: record.number,
      creditor: { name: 'Awa Créancière' },
      debtor: { name: 'SARL Bénin Négoce' },
      month: '2026-11',
      movements: [
        {
          date: '2026-11-20',
          label: 'Paiement en ligne du débiteur (Mobile Money ou carte)',
          collected: 100_000,
          commission: 10_000,
          costs: 0,
          remitted: 90_000,
        },
      ],
      situation: {
        status: 'En cours : notification du mandat',
        collectedToDate: 100_000,
        outstanding: 650_000,
      },
    });

    // Passage suivant, ou autre instance : rien de plus.
    expect(await world.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 0, failed: 0 });
    expect(store.statements.size).toBe(1);
  });

  it('facture de commission de billing reçue après le relevé : rattachée ; rejouée, sans effet', async () => {
    world.deps.clock.current = DECEMBER_FIRST;
    await world.useCases.issueMonthlyStatements.execute();
    expect(await invoice()).toEqual({ outcome: 'recorded', statements: 1 });
    expect(await invoice()).toEqual({ outcome: 'duplicate', statements: 0 });
    const page = await asCreditor(() => list());
    expect(page.items.map((item) => item.invoiceId)).toEqual([INVOICE_ID]);
  });

  it('facture reçue avant le relevé : rattachée à sa production ; événement mal formé ignoré', async () => {
    expect(await invoice()).toEqual({ outcome: 'recorded', statements: 0 });
    expect(
      await world.useCases.recordCommissionInvoice.execute({
        eventId: '0192f1c4-0000-7000-8000-0000000fe002',
        invoiceId: 'pas-un-uuid',
        invoiceNumber: 'FCR-2026-000002',
        creditor: { type: 'user', id: CREDITOR_ID },
        period: '2026-11',
        issuedAt: '2026-11-30T23:00:00.000Z',
      }),
    ).toEqual({ outcome: 'ignored', statements: 0 });
    world.deps.clock.current = DECEMBER_FIRST;
    await world.useCases.issueMonthlyStatements.execute();
    expect([...store.statements.values()][0]!.invoiceId).toBe(INVOICE_ID);
  });

  it('document injoignable : le dossier est repris au passage suivant', async () => {
    world.deps.clock.current = DECEMBER_FIRST;
    const documents = world.deps.documents;
    world.deps.documents = {
      ...documents,
      generate: () => Promise.reject(new Error('document indisponible')),
    };
    expect(await world.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 0, failed: 1 });
    world.deps.documents = documents;
    expect(await world.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 1, failed: 0 });
  });

  it('liste du créancier : ses relevés seulement, par mois et par dossier', async () => {
    world.deps.clock.current = DECEMBER_FIRST;
    await world.useCases.issueMonthlyStatements.execute();
    expect((await asCreditor(() => list())).items).toHaveLength(1);
    expect((await asCreditor(() => list({ period: '2026-11', caseId: record.id }))).items).toHaveLength(1);
    expect((await asCreditor(() => list({ period: '2026-10' }))).items).toHaveLength(0);
    expect((await asOtherCreditor(() => list())).items).toHaveLength(0);
    expect(await rejection(asCreditor(() => list({ period: '2026-13' })))).toMatchObject({
      code: 'RECOVERY_VALIDATION_FAILED',
      details: { field: 'period' },
    });
    expect(await rejection(asOtherCreditor(() => list({ caseId: record.id })))).toMatchObject({
      code: 'RECOVERY_CASE_NOT_FOUND',
    });
  });
});
