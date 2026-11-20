import { type AppError } from '@ksp/platform';
import { describeWithDatabase, HOOK_TIMEOUT_MS } from './support/database';
import { asCustomer, asStaff, type LotCBench, openLotCBench, VISIT_FEE } from './support/lot-c';

/**
 * Dossier du lot C sur une vraie base : annulations, refus, échéances et réactivation, avec les
 * décisions du responsable (CDC v2, partie 18) :
 * - frais de visite remboursés plus de 24 h avant la visite, perdus à 24 h exactement (partie 12) ;
 * - devis envoyé d'une demande annulée ou refusée : `withdrawn` (15.2) ;
 * - frais de visite de nouveau déductibles après une réactivation (R-AC-04).
 */
jest.setTimeout(120_000);

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

describeWithDatabase('dossier du lot C : annulations, refus, échéances (vraie base)', () => {
  let bench: LotCBench;

  beforeAll(async () => {
    bench = await openLotCBench('cleaning_lot_c_flows');
  }, HOOK_TIMEOUT_MS);

  afterAll(() => bench?.db.close(), HOOK_TIMEOUT_MS);

  const events = async (type: string, requestId: string) =>
    (await bench.db.prisma.outboxEvent.findMany({ where: { eventType: type } }))
      .map(
        (row) =>
          (row.payload as { payload?: Record<string, unknown> }).payload ??
          (row.payload as Record<string, unknown>),
      )
      .filter((payload) => payload.requestId === requestId);

  it('frais débités à l’envoi ; annulation plus de 24 h avant la visite : frais remboursés au wallet', async () => {
    bench.setNow('2026-11-20T09:00:00Z');
    bench.wallet.balance = VISIT_FEE;
    const submitted = await bench.submit('remb');
    expect(submitted.request.status).toBe('visit_to_schedule');
    expect(bench.wallet.balance).toBe(0);
    expect(await events('cleaning.request.submitted', submitted.request.id)).toEqual([
      expect.objectContaining({ visitFeeStatus: 'paid' }),
    ]);
    bench.setNow('2026-11-20T15:00:00Z');
    await asStaff(() =>
      bench.useCases.visitsAdmin.schedule({
        requestId: submitted.request.id,
        idempotencyKey: 'cle-visite-remb',
        scheduledAt: '2026-11-22T09:00:00Z',
        agentIds: [],
        overrides: [],
      }),
    );
    bench.setNow('2026-11-21T08:59:59Z');
    const cancelled = await asCustomer(() =>
      bench.useCases.requests.cancel({
        requestId: submitted.request.id,
        idempotencyKey: 'cle-annul-remb',
        reasonCode: 'no_longer_needed',
      }),
    );
    expect(cancelled.request.status).toBe('cancelled');
    expect(cancelled.fees[0]?.status).toBe('refunded');
    expect(cancelled.visits[0]).toMatchObject({ status: 'cancelled', cancelCause: 'request_cancelled' });
    expect(bench.wallet.balance).toBe(VISIT_FEE);
    const operations = await bench.db.prisma.walletOperation.findMany({
      where: { requestId: submitted.request.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(operations.map((op) => [op.purpose, op.status])).toEqual([
      ['visit_fee', 'succeeded'],
      ['visit_fee_refund', 'succeeded'],
    ]);
    expect(await events('cleaning.request.cancelled', submitted.request.id)).toEqual([
      expect.objectContaining({ cause: 'customer', visitFeeRefund: { amount: VISIT_FEE, currency: 'XOF' } }),
    ]);
  });

  it('annulation à 24 h exactement avant la visite : frais conservés (décision du responsable)', async () => {
    bench.setNow('2026-11-20T09:00:00Z');
    bench.wallet.balance = VISIT_FEE;
    const submitted = await bench.submit('exact');
    bench.setNow('2026-11-20T15:00:00Z');
    await asStaff(() =>
      bench.useCases.visitsAdmin.schedule({
        requestId: submitted.request.id,
        idempotencyKey: 'cle-visite-exact',
        scheduledAt: '2026-11-22T09:00:00Z',
        agentIds: [],
        overrides: [],
      }),
    );
    bench.setNow('2026-11-21T09:00:00Z');
    const cancelled = await asCustomer(() =>
      bench.useCases.requests.cancel({ requestId: submitted.request.id, idempotencyKey: 'cle-annul-exact' }),
    );
    expect(cancelled.fees[0]?.status).toBe('retained');
    expect(bench.wallet.balance).toBe(0);
  });

  it('refus par KSP après l’envoi du devis : devis retiré, frais conservés (visite faite)', async () => {
    const { requestId, quoteId } = await bench.toQuoteSent('refus');
    bench.setNow('2026-11-22T10:00:00Z');
    const rejected = await asStaff(() =>
      bench.useCases.requestAdmin.reject({
        requestId,
        idempotencyKey: 'cle-refus-0001',
        reasonCode: 'service_impossible',
        reason: 'Accès impossible au chantier',
      }),
    );
    expect(rejected.request.status).toBe('rejected');
    expect(rejected.quotes.find((quote) => quote.id === quoteId)).toMatchObject({
      status: 'withdrawn',
      withdrawalReason: 'request_rejected',
    });
    expect(rejected.fees[0]?.status).toBe('retained');
    expect(await events('cleaning.quote.withdrawn', requestId)).toHaveLength(1);
    const error = await failure(
      asCustomer(() =>
        bench.useCases.quotes.accept({
          quoteId,
          idempotencyKey: 'cle-acc-refus',
          acceptTerms: true,
          termsVersion: '',
        }),
      ),
    );
    expect(error).toMatchObject({ code: 'CLEANING_INVALID_TRANSITION' });
  });

  it('annulation par le client avec un devis envoyé : devis retiré (décision du responsable)', async () => {
    const { requestId, quoteId } = await bench.toQuoteSent('annul');
    bench.setNow('2026-11-22T10:00:00Z');
    const cancelled = await asCustomer(() =>
      bench.useCases.requests.cancel({ requestId, idempotencyKey: 'cle-annul-devis' }),
    );
    expect(cancelled.quotes.find((quote) => quote.id === quoteId)).toMatchObject({
      status: 'withdrawn',
      withdrawalReason: 'request_cancelled',
    });
    expect(cancelled.fees[0]?.status).toBe('retained');
  });

  it('échéances : rappel, expiration du devis, puis réactivation avec des frais de nouveau déductibles', async () => {
    const { requestId } = await bench.toQuoteSent('react');
    // Validité 15 jours depuis le 21 novembre à 11 h : rappel 2 jours avant, une seule fois.
    bench.setNow('2026-12-04T12:00:00Z');
    expect((await bench.useCases.deadlines.execute()).remindedQuotes).toBeGreaterThanOrEqual(1);
    await bench.useCases.deadlines.execute();
    expect(await events('cleaning.quote.expiry_reminded', requestId)).toHaveLength(1);

    bench.setNow('2026-12-06T11:00:00Z');
    await bench.useCases.deadlines.execute();
    const expired = await asCustomer(() => bench.useCases.requests.get(requestId));
    expect(expired.request.status).toBe('expired');
    expect(expired.fees[0]?.status).toBe('retained');
    expect(await events('cleaning.quote.expired', requestId)).toHaveLength(1);

    await asCustomer(() =>
      bench.useCases.requests.requestReactivation({ requestId, idempotencyKey: 'cle-react-0001' }),
    );
    const decided = await asStaff(() =>
      bench.useCases.requestAdmin.decideReactivation({
        requestId,
        idempotencyKey: 'cle-decide-001',
        decision: 'accept',
      }),
    );
    expect(decided.request.status).toBe('visit_done');
    expect(decided.fees[0]?.status).toBe('paid');
    bench.setNow('2026-12-06T12:00:00Z');
    const draft = await asStaff(() =>
      bench.useCases.quotesAdmin.create({
        requestId,
        idempotencyKey: 'cle-devis-reactive',
        schedule: {
          kind: 'weekly',
          startTime: '08:00',
          dates: [],
          weekdays: ['mon'],
          monthDays: [],
          monthWeekdays: [],
          startDate: '2026-12-14',
          durationWeeks: 2,
          excludedDates: [],
          addedDates: [],
          excludeHolidays: false,
        },
      }),
    );
    expect(draft.quote.visitFeeDeduction).toBe(VISIT_FEE);
  });

  it('frais impayés à l’échéance : demande annulée par la tâche (R-FV-03)', async () => {
    bench.setNow('2026-11-20T09:00:00Z');
    bench.wallet.balance = 0;
    const submitted = await bench.submit('impaye');
    expect(submitted.request.status).toBe('awaiting_visit_fee');
    bench.setNow('2026-11-23T09:00:00Z');
    const report = await bench.useCases.deadlines.execute();
    expect(report.cancelledForUnpaidFee).toBeGreaterThanOrEqual(1);
    const cancelled = await asCustomer(() => bench.useCases.requests.get(submitted.request.id));
    expect(cancelled.request.status).toBe('cancelled');
    expect(await events('cleaning.request.cancelled', submitted.request.id)).toEqual([
      expect.objectContaining({ cause: 'visit_fee_unpaid', visitFeeRefund: null }),
    ]);
  });
});
