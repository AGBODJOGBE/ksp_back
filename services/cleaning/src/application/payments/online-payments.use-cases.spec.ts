import { type AppError, runWithContext } from '@ksp/platform';
import { type Mission } from '../../domain/mission';
import { newPaymentState, paymentStatus } from '../../domain/payment';
import { type EvaluateStandingUseCase } from '../standing/standing.use-cases';
import { CUSTOMER_ID, ORGANIZATION_ID, testWorld, type TestWorld } from '../testing/fakes';
import { GetMissionAmountDueUseCase, RecordOnlinePaymentUseCase } from './online-payments.use-cases';

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';
const PAYMENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5001';
const EVENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001';

function mission(overrides: Partial<Mission> = {}): Mission {
  const now = new Date('2026-10-23T08:00:00Z');
  return {
    id: MISSION_ID,
    requestId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d2000',
    quoteId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d3000',
    customerId: CUSTOMER_ID,
    organizationId: null,
    status: 'scheduled',
    serviceCode: 'home_cleaning',
    commune: 'Cotonou',
    address: 'Lot 12',
    chosenSlot: { start: new Date('2026-10-30T08:00:00Z'), end: new Date('2026-10-30T11:00:00Z') },
    recurrence: null,
    plannedInterventions: 1,
    interventions: [],
    payment: newPaymentState(
      { option: 'deposit', timing: 'before', method: 'mobile_money_online' },
      50_000,
      30,
    ),
    cancellationReason: null,
    daysPerWeek: null,
    suspension: null,
    warningLevel: 0,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...overrides,
  };
}

const asService = <T>(service: string, fn: () => Promise<T>) =>
  runWithContext({ correlationId: 'c-test', callerService: service }, fn);

describe('paiement en ligne d’une mission (ADR-031)', () => {
  let world: TestWorld;
  let evaluated: string[];
  let record: RecordOnlinePaymentUseCase;
  const stored = () => world.missions.missions.get(MISSION_ID)!;

  beforeEach(() => {
    world = testWorld();
    evaluated = [];
    const evaluate = {
      execute: async (id: string) => {
        evaluated.push(id);
        return 'none';
      },
    } as unknown as EvaluateStandingUseCase;
    record = new RecordOnlinePaymentUseCase(world, evaluate);
    world.missions.missions.set(MISSION_ID, mission());
  });

  const succeeded = (overrides: Partial<Parameters<RecordOnlinePaymentUseCase['execute']>[0]> = {}) =>
    record.execute({
      eventId: EVENT_ID,
      eventType: 'payment.intent.succeeded',
      paymentId: PAYMENT_ID,
      subjectType: 'cleaning_mission',
      missionId: MISSION_ID,
      amount: 15_000,
      providerReference: 'trx_Ab12',
      succeededAt: '2026-10-24T09:00:00.000Z',
      ...overrides,
    });

  describe('montant dû (lu par payment)', () => {
    it('acompte encore dû et reste dû, calculés par cleaning', async () => {
      const due = await asService('payment', () => new GetMissionAmountDueUseCase(world).execute(MISSION_ID));
      expect(due).toMatchObject({ paid: 0, depositDue: 15_000, remainingDue: 50_000 });
    });

    it('acompte reçu : plus d’acompte dû ; plan « totalité » : jamais d’acompte', async () => {
      await succeeded();
      const due = await asService('payment', () => new GetMissionAmountDueUseCase(world).execute(MISSION_ID));
      expect(due).toMatchObject({ paid: 15_000, depositDue: 0, remainingDue: 35_000 });
      world.missions.missions.set(
        MISSION_ID,
        mission({
          payment: newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 50_000, 30),
        }),
      );
      const full = await asService('payment', () =>
        new GetMissionAmountDueUseCase(world).execute(MISSION_ID),
      );
      expect(full).toMatchObject({ depositDue: 0, remainingDue: 50_000 });
    });

    it('réservé à payment ; mission inconnue : 404', async () => {
      const other = asService('gateway', () => new GetMissionAmountDueUseCase(world).execute(MISSION_ID));
      expect(((await other.catch((e: unknown) => e)) as AppError).code).toBe('CLEANING_CALLER_FORBIDDEN');
      const unknown = asService('payment', () =>
        new GetMissionAmountDueUseCase(world).execute('0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9999'),
      );
      expect(((await unknown.catch((e: unknown) => e)) as AppError).code).toBe('CLEANING_MISSION_NOT_FOUND');
    });
  });

  describe('payment.intent.succeeded', () => {
    it('enregistre le paiement (mobile_money_online, système) : acompte reçu', async () => {
      expect(await succeeded()).toBe('recorded');
      const payment = stored().payment;
      expect(payment.payments).toEqual([
        expect.objectContaining({
          amount: 15_000,
          method: 'mobile_money_online',
          reference: 'trx_Ab12',
          recordedBy: 'system',
          recordedAt: new Date('2026-10-24T09:00:00.000Z'),
          idempotencyKey: `online-${PAYMENT_ID}`,
        }),
      ]);
      expect(paymentStatus(payment)).toBe('deposit_received');
      expect(world.recorder.audit).toEqual([
        expect.objectContaining({
          action: 'payment.recorded_online',
          actorId: 'system',
          entityId: MISSION_ID,
        }),
      ]);
    });

    it('idempotent : même événement (inbox) ou même paiement (clé) → un seul enregistrement', async () => {
      await succeeded();
      expect(await succeeded()).toBe('duplicate');
      expect(await succeeded({ eventId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6002' })).toBe('duplicate');
      expect(stored().payment.payments).toHaveLength(1);
    });

    it('solde : mission payée', async () => {
      await succeeded();
      await succeeded({
        eventId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6002',
        paymentId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5002',
        amount: 35_000,
      });
      expect(paymentStatus(stored().payment)).toBe('paid');
    });

    it('au-delà du reste dû : enregistré quand même, excédent tracé', async () => {
      await succeeded({ amount: 60_000 });
      expect(world.recorder.audit[0]?.details).toMatchObject({ amount: 60_000, excess: 10_000 });
    });

    it('mission suspendue : situation réévaluée (levée de la suspension pour impayé)', async () => {
      world.missions.missions.set(
        MISSION_ID,
        mission({
          suspension: {
            causes: ['unpaid_interventions'],
            since: new Date('2026-10-23T08:00:00Z'),
            unpaidCount: 1,
          },
        }),
      );
      await succeeded();
      expect(evaluated).toEqual([MISSION_ID]);
    });

    it('facture, mission inconnue ou d’entreprise : ignoré', async () => {
      expect(await succeeded({ subjectType: 'billing_invoice' })).toBe('ignored');
      expect(await succeeded({ missionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9999' })).toBe('ignored');
      world.missions.missions.set(MISSION_ID, mission({ organizationId: ORGANIZATION_ID }));
      expect(await succeeded()).toBe('ignored');
      expect(stored().payment.payments).toHaveLength(0);
    });
  });
});
