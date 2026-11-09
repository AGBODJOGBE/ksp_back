import { type AppError } from '@ksp/platform';
import { type Mission } from '../../domain/mission';
import { newPaymentState, paidAmount, paymentStatus, remainingDue } from '../../domain/payment';
import { CancelMissionAsSupervisorUseCase } from '../missions/admin-missions.use-cases';
import { CancelMyMissionUseCase } from '../missions/customer-missions.use-cases';
import {
  as,
  CUSTOMER_ID,
  OTHER_CUSTOMER_ID,
  ORGANIZATION_ID,
  SUPERVISOR_ID,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import { PayMissionFromWalletUseCase } from './wallet-payments.use-cases';

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';
const KEY = 'wallet-pay-0001';

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
    location: null,
    landmark: null,
    groupId: null,
    placeType: null,
    chosenSlot: { start: new Date('2026-10-30T08:00:00Z'), end: new Date('2026-10-30T11:00:00Z') },
    recurrence: null,
    plannedInterventions: 1,
    interventions: [],
    payment: newPaymentState({ option: 'deposit', timing: 'before', method: 'cash' }, 50_000, 30),
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

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('paiement d’une mission par le portefeuille (ADR-046)', () => {
  let world: TestWorld;
  const stored = () => world.missions.missions.get(MISSION_ID)!;

  beforeEach(() => {
    world = testWorld();
    world.missions.missions.set(MISSION_ID, mission());
    world.wallet.balances.set(CUSTOMER_ID, 100_000);
  });

  const pay = (part = 'deposit', key = KEY, userId = CUSTOMER_ID) =>
    as(userId, () =>
      new PayMissionFromWalletUseCase(world).execute({ missionId: MISSION_ID, part, idempotencyKey: key }),
    );

  it('acompte débité puis enregistré (moyen wallet) ; même clé : aucun second débit', async () => {
    const view = await pay();
    expect(paymentStatus(view.mission.payment)).toBe('deposit_received');
    const [record] = stored().payment.payments;
    expect(record).toMatchObject({
      amount: 15_000,
      method: 'wallet',
      recordedBy: CUSTOMER_ID,
      refundedAt: null,
    });
    expect(world.wallet.balances.get(CUSTOMER_ID)).toBe(85_000);
    const [[debitKey]] = [...world.wallet.debits.entries()];
    expect(debitKey).toBe(`${MISSION_ID}:deposit:${KEY}`);
    expect(record!.reference).toBe(world.wallet.debits.get(debitKey!)!.transactionId);
    await pay();
    expect(stored().payment.payments).toHaveLength(1);
    expect(world.wallet.balances.get(CUSTOMER_ID)).toBe(85_000);
    expect(world.recorder.audit.at(-1)).toMatchObject({ action: 'payment.recorded_wallet' });
  });

  it('solde : reste dû en entier ; rien à payer ensuite', async () => {
    await pay();
    await pay('balance', 'wallet-pay-0002');
    expect(remainingDue(stored().payment)).toBe(0);
    expect((await rejection(pay('balance', 'wallet-pay-0003'))).code).toBe('CLEANING_NOTHING_DUE');
    expect((await rejection(pay('deposit', 'wallet-pay-0004'))).code).toBe('CLEANING_NOTHING_DUE');
  });

  it('portefeuille insuffisant : refus de wallet transmis, rien d’enregistré', async () => {
    world.wallet.balances.set(CUSTOMER_ID, 10_000);
    const error = await rejection(pay());
    expect(error).toMatchObject({
      code: 'WALLET_INSUFFICIENT_FUNDS',
      details: { missing: { amount: 5_000 } },
    });
    expect(stored().payment.payments).toEqual([]);
  });

  it('refus : mission d’un autre, d’entreprise, annulée ; part invalide', async () => {
    expect((await rejection(pay('deposit', KEY, OTHER_CUSTOMER_ID))).code).toBe('CLEANING_MISSION_NOT_FOUND');
    expect((await rejection(pay('all'))).code).toBe('CLEANING_VALIDATION_FAILED');
    world.missions.missions.set(MISSION_ID, mission({ organizationId: ORGANIZATION_ID }));
    expect((await rejection(pay())).code).toBe('CLEANING_PAYMENT_VIA_INVOICE');
    world.missions.missions.set(MISSION_ID, mission({ status: 'cancelled' }));
    expect((await rejection(pay())).code).toBe('CLEANING_INVALID_TRANSITION');
    expect(world.wallet.debits.size).toBe(0);
  });

  it('payée entre-temps : le débit est remboursé aussitôt', async () => {
    const debit = world.wallet.debit.bind(world.wallet);
    // Pendant le débit : la totalité est payée en espèces ailleurs (version de la mission changée).
    world.wallet.debit = async (input) => {
      const result = await debit(input);
      const current = stored();
      world.missions.missions.set(MISSION_ID, {
        ...current,
        payment: {
          ...current.payment,
          payments: [
            {
              id: 'p-cash',
              amount: 50_000,
              method: 'cash',
              reference: null,
              recordedBy: SUPERVISOR_ID,
              recordedAt: new Date(),
              idempotencyKey: null,
              refundedAt: null,
            },
          ],
        },
        version: current.version + 1,
      });
      return result;
    };
    const error = await rejection(pay());
    expect(error.code).toBe('CLEANING_PAYMENT_INVALID');
    expect(world.wallet.refunds).toHaveLength(1);
  });

  it('annulation sans passage commencé : paiements par portefeuille remboursés (événement)', async () => {
    await pay();
    await as(CUSTOMER_ID, () =>
      new CancelMyMissionUseCase(world).execute({ missionId: MISSION_ID, reason: 'Déménagement' }),
    );
    const [record] = stored().payment.payments;
    expect(record!.refundedAt).not.toBeNull();
    expect(paidAmount(stored().payment)).toBe(0);
    expect(world.recorder.events.find((e) => e.type === 'cleaning.mission.refunded')).toMatchObject({
      payload: {
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        refunds: [
          { paymentRecordId: record!.id, walletTransactionId: record!.reference, amount: { amount: 15_000 } },
        ],
        reason: 'mission_cancelled',
      },
    });
  });

  it('annulation par la supervision après un passage commencé : aucun remboursement automatique', async () => {
    await pay();
    const current = stored();
    world.missions.missions.set(MISSION_ID, {
      ...current,
      status: 'in_progress',
      interventions: [
        {
          id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d4000',
          status: 'completed',
          scheduledStart: new Date('2026-10-30T08:00:00Z'),
          durationMinutes: 180,
          agentIds: [],
          checklist: [],
          incidentNote: null,
          beforePhotoFileIds: [],
          afterPhotoFileIds: [],
          startedAt: new Date('2026-10-30T08:00:00Z'),
          completedAt: new Date('2026-10-30T11:00:00Z'),
          cancellationCause: null,
          cancelledAt: null,
        },
      ],
    });
    await as(
      SUPERVISOR_ID,
      () =>
        new CancelMissionAsSupervisorUseCase(world).execute({
          missionId: MISSION_ID,
          reason: 'Client parti',
        }),
      { roles: ['cleaning_supervisor'], mfa: true },
    );
    expect(stored().payment.payments[0]!.refundedAt).toBeNull();
    expect(world.recorder.events.some((e) => e.type === 'cleaning.mission.refunded')).toBe(false);
  });
});
