import {
  activeCase,
  type AmicableWorld,
  amicableWorld,
  asSupervisor,
  at,
  caseOf,
  eventsOf,
} from '../testing/amicable-scenarios';
import { rejection } from '../testing/fakes';

/** 750 000 FCFA : 75 000 le 30 novembre, puis 5 mensualités de 135 000 (dans le barème B2B). */
const IN_SCALE = { firstAmount: 75_000, firstDueDate: '2026-11-30', rhythm: 'monthly', installmentsCount: 5 };

describe('échéancier après la mise en demeure (6.1)', () => {
  let world: AmicableWorld;
  let caseId: string;
  let debtorId: string;

  /** Dossier passé en relance amiable puis en mise en demeure par le superviseur. */
  async function toStage(stage: 'amicable' | 'formal_notice') {
    await asSupervisor(world, () =>
      world.useCases.changeCaseStage.execute({
        caseId,
        toStage: 'amicable',
        reason: 'Sans réponse',
        skipReason: '',
      }),
    );
    if (stage === 'formal_notice') {
      await asSupervisor(world, () =>
        world.useCases.changeCaseStage.execute({
          caseId,
          toStage: 'formal_notice',
          reason: 'Relance amiable sans résultat',
          skipReason: '',
        }),
      );
    }
  }

  const debtorProposes = (key = 'plan-key-0001') =>
    world.useCases.proposeDebtorPaymentPlan.execute({
      caseId,
      debtorId,
      idempotencyKey: key,
      terms: IN_SCALE,
      message: 'Suite à la mise en demeure, je propose un échéancier',
    });

  const sign = (documentId: string) =>
    world.useCases.recordPlanSignature.execute({
      eventId: '0192f1c4-0000-7000-8000-00000000fa01',
      documentId,
      template: 'recovery_settlement_agreement',
      producerService: 'recovery',
      subjectType: 'recovery_case',
      subjectId: caseId,
      signedAt: world.deps.clock.current.toISOString(),
    });

  beforeEach(async () => {
    world = amicableWorld();
    const record = await activeCase(world);
    caseId = record.id;
    debtorId = record.debtors[0]!.id;
  });

  it('proposé et signé à la mise en demeure : retour à l’échéancier, commission de la mise en demeure gardée', async () => {
    await toStage('formal_notice');
    expect(caseOf(world, caseId)).toMatchObject({ stage: 'formal_notice', highestStage: 'formal_notice' });

    const plan = await debtorProposes();
    expect(plan).toMatchObject({ status: 'proposed', withinScale: true, signatureRound: 1 });
    at(world, '2026-11-21T10:00:00.000Z');
    expect(await sign(plan.documentId!)).toBe('recorded');

    expect(caseOf(world, caseId)).toMatchObject({ stage: 'payment_plan', highestStage: 'formal_notice' });
    expect(eventsOf(world, 'recovery.case.stage_changed').at(-1)!.payload).toMatchObject({
      fromStage: 'formal_notice',
      toStage: 'payment_plan',
      changedBy: 'system',
    });
    expect(world.deps.cases.transitions.at(-1)).toMatchObject({ from: 'formal_notice', to: 'payment_plan' });
  });

  it('rompu après la mise en demeure : retour à la mise en demeure, pas à la relance amiable', async () => {
    await toStage('formal_notice');
    const plan = await debtorProposes();
    at(world, '2026-11-21T10:00:00.000Z');
    await sign(plan.documentId!);

    // Rien n'est payé : 2 échéances manquées (30 novembre, 30 décembre) après la grâce de 5 jours.
    at(world, '2027-01-06T10:00:00.000Z');
    const report = await world.useCases.watchAmicable.execute();
    expect(report.plansDefaulted).toBe(1);
    expect(world.store.planRows.get(plan.id)!.status).toBe('defaulted');
    expect(caseOf(world, caseId)).toMatchObject({ stage: 'formal_notice', highestStage: 'formal_notice' });
    expect(eventsOf(world, 'recovery.case.stage_changed').at(-1)!.payload).toMatchObject({
      fromStage: 'payment_plan',
      toStage: 'formal_notice',
    });
  });

  it('rompu sans mise en demeure faite : relance amiable, comme avant', async () => {
    await toStage('amicable');
    const plan = await debtorProposes();
    at(world, '2026-11-21T10:00:00.000Z');
    await sign(plan.documentId!);
    expect(caseOf(world, caseId).stage).toBe('payment_plan');

    at(world, '2027-01-06T10:00:00.000Z');
    await world.useCases.watchAmicable.execute();
    expect(caseOf(world, caseId)).toMatchObject({ stage: 'amicable', highestStage: 'amicable' });
  });

  it('chez l’huissier, aucun échéancier ne se propose', async () => {
    await toStage('formal_notice');
    const stored = world.deps.cases.cases.get(caseId)!;
    stored.stage = 'bailiff';
    stored.highestStage = 'bailiff';
    expect(await rejection(debtorProposes())).toMatchObject({
      code: 'RECOVERY_INVALID_TRANSITION',
    });
  });
});
