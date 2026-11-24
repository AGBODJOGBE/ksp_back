import { planNewProgram } from '../src/application/auto-planning/auto-planning.use-cases';
import { describeWithDatabase, HOOK_TIMEOUT_MS } from './support/database';
import { asCustomer, type LotCBench, openLotCBench } from './support/lot-c';

/**
 * Acceptation d'un devis et planification (R-PL-01, décision du responsable) : les séances de
 * l'horizon sont planifiées aussitôt, hors de la transaction de l'acceptation. Le passage de
 * planification lui-même est testé avec le lot G (lot-g.auto-planning.int.spec.ts).
 */
jest.mock('../src/application/auto-planning/auto-planning.use-cases', () => ({
  ...jest.requireActual<object>('../src/application/auto-planning/auto-planning.use-cases'),
  planNewProgram: jest.fn(),
}));
jest.setTimeout(120_000);

const planning = jest.mocked(planNewProgram);

describeWithDatabase('acceptation d’un devis : planification immédiate (vraie base)', () => {
  let bench: LotCBench;

  beforeAll(async () => {
    bench = await openLotCBench('cleaning_lot_c_plan');
  }, HOOK_TIMEOUT_MS);

  afterAll(() => bench?.db.close(), HOOK_TIMEOUT_MS);

  beforeEach(() => planning.mockReset());

  const accept = (quoteId: string, key: string) =>
    asCustomer(() =>
      bench.useCases.quotes.accept({ quoteId, idempotencyKey: key, acceptTerms: true, termsVersion: '' }),
    );

  it('le programme confirmé est planifié une fois, après l’enregistrement de l’acceptation', async () => {
    const { quoteId } = await bench.toQuoteSent('plan');
    bench.setNow('2026-11-21T22:00:00Z');
    let confirmedWhenPlanned: string | null = null;
    planning.mockImplementation(async (_deps, programId) => {
      const program = await bench.db.prisma.program.findUnique({ where: { id: programId } });
      confirmedWhenPlanned = program?.status ?? null;
      return null;
    });

    const accepted = await accept(quoteId, 'cle-acc-plan-01');

    expect(planning).toHaveBeenCalledTimes(1);
    expect(planning.mock.calls[0]?.[1]).toBe(accepted.program.id);
    expect(confirmedWhenPlanned).toBe('confirmed');
  });

  it('planification en panne : le devis reste accepté et le programme confirmé', async () => {
    const { requestId, quoteId } = await bench.toQuoteSent('panne');
    bench.setNow('2026-11-21T22:00:00Z');
    planning.mockRejectedValue(new Error('temps de trajet indisponibles'));

    const accepted = await accept(quoteId, 'cle-acc-plan-02');

    expect(accepted.quote.status).toBe('accepted');
    const program = await bench.db.prisma.program.findUniqueOrThrow({ where: { id: accepted.program.id } });
    expect(program).toMatchObject({ requestId, status: 'confirmed' });
  });
});
