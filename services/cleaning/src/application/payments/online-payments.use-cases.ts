import { type Mission } from '../../domain/mission';
import {
  depositDue,
  onlinePaymentIds,
  onlinePaymentKey,
  paidAmount,
  type PaymentRecord,
  paymentWithKey,
  remainingDue,
} from '../../domain/payment';
import { isBusinessContract } from '../../domain/standing';
import { type CleaningDeps } from '../deps';
import { requireCaller } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { requireUuid } from '../shared/validation';
import { type EvaluateStandingUseCase, SYSTEM_ACTOR } from '../standing/standing.use-cases';

/** Seul payment lit le montant dû d'une mission (ADR-031). */
const PAYMENT_CALLERS = ['payment'];
/** Consommateur des événements de payment : file `cleaning.<événement>`. */
export const PAYMENT_CONSUMER = 'cleaning';
const MAX_ATTEMPTS = 3;

export interface MissionAmountDue {
  mission: Mission;
  paid: number;
  depositDue: number;
  remainingDue: number;
  /** Paiements en ligne déjà enregistrés (identifiants payment, ADR-032). */
  onlinePaymentIds: string[];
}

/**
 * MissionPaymentDueService.GetMissionAmountDue : acompte encore dû et reste dû d'une mission, tels
 * que cleaning les calcule (payment n'en recalcule aucun). payment vérifie lui-même que le payeur
 * est le client de la mission.
 */
export class GetMissionAmountDueUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(missionId: string): Promise<MissionAmountDue> {
    requireCaller(PAYMENT_CALLERS);
    const mission = await this.deps.missions.findById(requireUuid('missionId', missionId));
    if (!mission) throw CleaningErrors.missionNotFound();
    return {
      mission,
      paid: paidAmount(mission.payment),
      depositDue: depositDue(mission.payment),
      remainingDue: remainingDue(mission.payment),
      onlinePaymentIds: onlinePaymentIds(mission.payment),
    };
  }
}

export type OnlinePaymentOutcome = 'recorded' | 'duplicate' | 'ignored';

/** Issue, et trop-perçu éventuel (à rembourser : différé, ADR-031), comme pour une facture. */
export interface OnlinePaymentResult {
  outcome: OnlinePaymentOutcome;
  excess: number;
}

/**
 * payment.intent.succeeded : paiement en ligne confirmé par le prestataire, enregistré sur la
 * mission (moyen `mobile_money_online`, auteur `system`), avec l'inbox dans la même transaction :
 * un événement reçu deux fois n'a qu'un effet. Le statut de paiement de la mission en découle ; si
 * la mission était suspendue pour un passage impayé, sa situation est réévaluée (levée de la
 * suspension). La réévaluation a lieu même pour un doublon : si un premier traitement a échoué
 * après l'inbox, la nouvelle tentative la termine.
 *
 * L'argent reçu est toujours enregistré, même au-delà du reste dû (paiement tardif d'une page déjà
 * ouverte) : l'excédent est tracé pour un remboursement, différé (ADR-031). Sur une mission annulée,
 * tout le paiement est en trop (ADR-049) : payment n'ouvre plus de page pour elle.
 */
export class RecordOnlinePaymentUseCase {
  constructor(
    private readonly deps: CleaningDeps,
    private readonly evaluate: EvaluateStandingUseCase,
  ) {}

  async execute(input: {
    eventId: string;
    eventType: string;
    paymentId: string;
    subjectType: string;
    missionId: string;
    amount: number;
    providerReference: string | null;
    succeededAt: string;
  }): Promise<OnlinePaymentResult> {
    const ignored = { outcome: 'ignored' as const, excess: 0 };
    if (input.subjectType !== 'cleaning_mission') return ignored;
    const key = onlinePaymentKey(input.paymentId);
    let outcome: OnlinePaymentOutcome | null = null;
    let excess = 0;
    let suspended = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !outcome; attempt += 1) {
      const mission = await this.deps.missions.findById(input.missionId);
      // Mission inconnue ou d'entreprise (réglée par sa facture) : payment ne l'aurait pas acceptée.
      if (!mission || isBusinessContract(mission)) return ignored;
      suspended = Boolean(mission.suspension);
      if (paymentWithKey(mission.payment, key)) {
        outcome = 'duplicate';
        break;
      }
      const now = this.deps.clock.now();
      const succeededAt = new Date(input.succeededAt);
      const record: PaymentRecord = {
        id: this.deps.ids.next(),
        amount: input.amount,
        method: 'mobile_money_online',
        reference: input.providerReference ? input.providerReference.slice(0, 100) : null,
        recordedBy: SYSTEM_ACTOR,
        recordedAt: Number.isNaN(succeededAt.getTime()) ? now : succeededAt,
        idempotencyKey: key,
        refundedAt: null,
      };
      const received =
        mission.status === 'cancelled'
          ? input.amount
          : Math.max(0, paidAmount(mission.payment) + input.amount - mission.payment.total);
      const result = await this.deps.missions.saveFromEvent(
        {
          ...mission,
          payment: { ...mission.payment, payments: [...mission.payment.payments, record] },
          updatedAt: now,
        },
        {
          events: [],
          audit: [
            {
              actorId: SYSTEM_ACTOR,
              action: 'payment.recorded_online',
              entityType: 'mission',
              entityId: mission.id,
              at: now,
              details: {
                paymentId: input.paymentId,
                recordId: record.id,
                amount: input.amount,
                method: record.method,
                ...(received ? { excess: received } : {}),
              },
            },
          ],
        },
        { eventId: input.eventId, consumer: `${PAYMENT_CONSUMER}.${input.eventType}` },
      );
      if (result === 'saved') {
        outcome = 'recorded';
        excess = received;
      } else if (result === 'duplicate') outcome = 'duplicate';
    }
    if (!outcome) throw CleaningErrors.concurrentUpdate();
    if (suspended) await this.evaluate.execute(input.missionId);
    return { outcome, excess };
  }
}
