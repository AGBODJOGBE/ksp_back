import { type Mission } from '../../domain/mission';
import {
  depositDue,
  MISSION_PARTS,
  type MissionPart,
  paidAmount,
  type PaymentRecord,
  paymentWithKey,
  remainingDue,
  walletPaymentKey,
} from '../../domain/payment';
import { isBusinessContract } from '../../domain/standing';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { currentCustomer, requireCaller } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { eventSubject } from '../shared/event-subject';
import { oneOf, requireUuid } from '../shared/validation';
import { EvaluateStandingUseCase } from '../standing/standing.use-cases';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_ATTEMPTS = 3;
/** Seul wallet rapproche ses débits (ADR-048). */
const WALLET_CALLERS = ['wallet'];

/**
 * Acompte ou solde d'une mission payé depuis le portefeuille prépayé du client (ADR-046).
 *
 * Le montant dû (acompte encore dû, ou reste dû) est débité en entier du portefeuille par wallet,
 * puis le paiement est enregistré sur la mission (moyen `wallet`, reference = débit), avec les mêmes
 * effets qu'un paiement enregistré : reste dû, statut, levée d'une suspension pour impayés. Solde
 * insuffisant : WALLET_INSUFFICIENT_FUNDS (montant manquant), rien n'est débité ni enregistré.
 *
 * Idempotent par la clé du client : la même clé ne débite qu'une fois (clé du débit dérivée de la
 * mission, de la part et de cette clé) et n'enregistre qu'un paiement : après une panne, le client
 * renvoie la même clé, le débit est rejoué et enregistré. Si le paiement ne peut plus être enregistré
 * (mission annulée ou payée entre-temps), le débit est remboursé aussitôt. Une mission d'entreprise se
 * règle par sa facture.
 */
export class PayMissionFromWalletUseCase {
  private readonly evaluate: EvaluateStandingUseCase;

  constructor(private readonly deps: CleaningDeps) {
    this.evaluate = new EvaluateStandingUseCase(deps);
  }

  async execute(input: { missionId: string; part: string; idempotencyKey: string }): Promise<MissionView> {
    const customer = currentCustomer();
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw CleaningErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const part = oneOf<MissionPart>('part', input.part, MISSION_PARTS);
    const key = walletPaymentKey(input.idempotencyKey);
    let mission = await this.ownMission(requireUuid('missionId', input.missionId), customer.userId);
    if (paymentWithKey(mission.payment, key)) return missionView(this.deps, mission);
    if (mission.status === 'cancelled') throw CleaningErrors.invalidTransition(mission.status, 'paid');
    if (isBusinessContract(mission)) throw CleaningErrors.paymentViaInvoice();
    const amount = part === 'deposit' ? depositDue(mission.payment) : remainingDue(mission.payment);
    if (amount <= 0) throw CleaningErrors.nothingDue(part);

    const subject = await eventSubject(this.deps, mission);
    const debit = await this.deps.wallet.debit({
      idempotencyKey: `${mission.id}:${part}:${input.idempotencyKey}`,
      holder: { type: 'user', id: mission.customerId },
      amount,
      object: { objectType: 'cleaning_mission', objectId: mission.id, part },
      description: `${subject.serviceName ?? 'Nettoyage'} — ${part === 'deposit' ? 'acompte' : 'solde'}`,
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        mission = await this.ownMission(mission.id, customer.userId);
        if (paymentWithKey(mission.payment, key)) return missionView(this.deps, mission);
      }
      // Payée ou annulée entre-temps : le débit n'est pas enregistré, il est remboursé.
      if (
        mission.status === 'cancelled' ||
        paidAmount(mission.payment) + debit.amount > mission.payment.total
      ) {
        break;
      }
      const now = this.deps.clock.now();
      const record: PaymentRecord = {
        id: this.deps.ids.next(),
        amount: debit.amount,
        method: 'wallet',
        reference: debit.transactionId,
        recordedBy: customer.userId,
        recordedAt: now,
        idempotencyKey: key,
        refundedAt: null,
      };
      const next: Mission = {
        ...mission,
        payment: { ...mission.payment, payments: [...mission.payment.payments, record] },
        updatedAt: now,
      };
      const saved = await this.deps.missions.save(next, {
        events: [],
        audit: [
          {
            actorId: customer.userId,
            action: 'payment.recorded_wallet',
            entityType: 'mission',
            entityId: mission.id,
            at: now,
            details: { paymentId: record.id, amount: record.amount, method: 'wallet', part },
          },
        ],
      });
      if (!saved) continue;
      if (mission.suspension) await this.evaluate.execute(mission.id);
      return missionView(this.deps, await this.ownMission(mission.id, customer.userId));
    }
    // Modifiée sans cesse en même temps : la même clé reprendra ce débit.
    if (
      mission.status !== 'cancelled' &&
      paidAmount(mission.payment) + debit.amount <= mission.payment.total
    ) {
      throw CleaningErrors.concurrentUpdate();
    }
    await this.deps.wallet.refund({ transactionId: debit.transactionId, reason: 'paiement non enregistré' });
    if (mission.status === 'cancelled') throw CleaningErrors.invalidTransition(mission.status, 'paid');
    throw CleaningErrors.paymentExceedsBalance(remainingDue(mission.payment));
  }

  /** Mission du client, sinon introuvable (404). */
  private async ownMission(missionId: string, userId: string): Promise<Mission> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission || mission.customerId !== userId) throw CleaningErrors.missionNotFound();
    return mission;
  }
}

/**
 * WalletDebitCheckService.GetWalletDebitStatus (ADR-048) : wallet rapproche un débit fait pour une
 * mission dont l'enregistrement a pu échouer (panne entre le débit et l'enregistrement). true si un
 * paiement par portefeuille de la mission cite ce débit, remboursé ou non ; false sinon, mission
 * inconnue comprise : wallet rembourse alors le débit.
 */
export class GetWalletDebitStatusUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { missionId: string; transactionId: string }): Promise<boolean> {
    requireCaller(WALLET_CALLERS);
    const transactionId = requireUuid('transactionId', input.transactionId);
    const mission = await this.deps.missions.findById(requireUuid('missionId', input.missionId));
    return (
      mission?.payment.payments.some(
        (payment) => payment.method === 'wallet' && payment.reference === transactionId,
      ) ?? false
    );
  }
}
