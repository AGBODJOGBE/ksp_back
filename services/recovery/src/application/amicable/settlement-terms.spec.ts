import { NO_SETTLEMENTS } from '../debtor-space/settlement-terms';
import { CaseClosure } from '../money/case-closure.service';
import { activeCase, amicableWorld, asAgent, caseOf } from '../testing/amicable-scenarios';
import { FILE_2 } from '../testing/case-scenarios';
import { AmicableSettlementTerms } from './settlement-terms';

describe('remise payée par le lien du débiteur (R3 et R4)', () => {
  it('payable jusqu’à la fin de sa date, puis exécutée et dossier clos, sans double clôture', async () => {
    const world = amicableWorld();
    const record = await activeCase(world, 'settle-case', {
      claims: [{ reference: 'F-88', amount: 500_000, dueDate: '2026-10-01', description: '' }],
      evidenceFileIds: [FILE_2],
      planScale: {
        acceptsPaymentPlan: true,
        maxDurationMonths: 12,
        minFirstPaymentBps: 1_000,
        firstPaymentWithinDays: 15,
        minInstallment: 25_000,
        maxDiscountBps: 1_000,
      },
    });
    const settlement = await asAgent(world, () =>
      world.useCases.proposeSettlement.execute({
        caseId: record.id,
        idempotencyKey: 'settle-0001',
        payNow: 450_000,
        validUntil: '2026-11-25',
        note: '',
      }),
    );
    const terms = new AmicableSettlementTerms(
      world.deps,
      new CaseClosure({ ...world.deps, settlementTerms: NO_SETTLEMENTS }),
    );
    const payable = (caseId: string, instant: string) =>
      terms.payable({ caseId, settlementId: settlement.id, at: new Date(instant) });

    // 22 h 30 au Bénin le 25 : encore valable ; le 26 au matin : expirée.
    expect(await payable(record.id, '2026-11-25T21:30:00.000Z')).toMatchObject({
      id: settlement.id,
      caseId: record.id,
      payNow: 450_000,
    });
    expect(await payable(record.id, '2026-11-26T08:00:00.000Z')).toBeNull();
    expect(await payable('0192f1c4-0000-7000-8000-0000000000ff', '2026-11-25T09:00:00.000Z')).toBeNull();

    const paid = { settlementId: settlement.id, caseId: record.id, collectionId: 'c-1' };
    await terms.paid({ ...paid, at: new Date('2026-11-25T10:00:00.000Z') });
    expect(world.store.settlementRows.get(settlement.id)!.status).toBe('executed');
    expect(caseOf(world, record.id)).toMatchObject({ status: 'closed' });

    // Rejoué : rien ne change, et une remise exécutée n'est plus payable.
    await expect(terms.paid({ ...paid, at: new Date('2026-11-25T10:05:00.000Z') })).resolves.toBeUndefined();
    expect(await payable(record.id, '2026-11-25T11:00:00.000Z')).toBeNull();
  });
});
