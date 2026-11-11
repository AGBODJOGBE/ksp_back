import { AppError } from '@ksp/platform';
import { CURRENCY } from '../domain/payment-intent';
import {
  applyProviderPayoutStatus,
  markSubmitted,
  type Payout,
  type PayoutTransition,
  recordProviderPayout,
  rejectByProvider,
} from '../domain/payout';
import { type OutboxMessage, type PaymentDeps } from './ports';
import { PaymentErrors, rejectedStatus } from './shared/errors';

const MAX_ATTEMPTS = 3;

/** Événement d'une issue définitive : identifiants et montants seulement (ni numéro, ni nom, ni raison). */
export function payoutEvents(transition: NonNullable<PayoutTransition>): OutboxMessage[] {
  const payout = transition.payout;
  const ref = {
    payoutId: payout.id,
    issuer: payout.issuer,
    reference: payout.reference,
    amount: { amount: payout.amount, currency: CURRENCY as 'XOF' },
    provider: payout.provider,
  };
  if (transition.kind === 'completed') {
    return [
      {
        type: 'payment.payout.completed',
        payload: {
          ...ref,
          providerReference: payout.providerReference,
          completedAt: (payout.completedAt ?? payout.updatedAt).toISOString(),
        },
      },
    ];
  }
  if (transition.kind === 'failed') {
    return [
      {
        type: 'payment.payout.failed',
        payload: {
          ...ref,
          // Code publié (schéma v1) : un refus définitif du prestataire reste `provider_failed` ;
          // `provider_rejected` est gardé dans payment (back-office, ADR-048).
          failureCode:
            payout.failureCode === 'rejected_by_finance' ? 'rejected_by_finance' : 'provider_failed',
          failedAt: (payout.failedAt ?? payout.updatedAt).toISOString(),
        },
      },
    ];
  }
  return [];
}

/** Panne du prestataire (réseau, délai) : le reversement attend le prochain passage. */
function isOutage(error: unknown): boolean {
  return error instanceof AppError && (error.kind === 'UNAVAILABLE' || error.kind === 'DEADLINE_EXCEEDED');
}

/**
 * Fait avancer un reversement chez le prestataire (ADR-041) et enregistre chaque changement sous
 * contrôle de version, avec son événement (outbox) : une issue n'est publiée qu'une fois.
 */
export class PayoutSync {
  constructor(private readonly deps: PaymentDeps) {}

  /**
   * Reversement `requested` d'un prestataire automatique : créé chez lui s'il ne l'est pas, puis
   * lancé **une seule fois** (ADR-048) : il est noté `processing` avant l'appel de lancement, et un
   * reversement soumis n'est plus jamais relancé (seulement relu). Une panne à la création le laisse
   * `requested` (le rapprochement reprend ; une création perdue ne fait partir aucun argent). Une
   * panne au lancement le laisse `processing`, avec une alerte : la relecture tranche. Un refus
   * définitif du prestataire (HTTP 4xx) le met en échec `provider_rejected`, avec une alerte, sans
   * nouvel essai. Mode manuel : rien.
   */
  async advance(payout: Payout): Promise<Payout> {
    const provider = this.deps.payoutProvider;
    if (!provider.automatic || payout.status !== 'requested') return payout;
    let current = payout;
    let stage: 'create' | 'start' = 'create';
    try {
      if (!current.providerPayoutId) {
        const created = await provider.createPayout({
          payoutId: current.id,
          amount: current.amount,
          currency: 'XOF',
          beneficiary: current.beneficiary,
        });
        current = await this.store(
          recordProviderPayout(current, { ...created, now: this.deps.clock.now() }),
          null,
        );
        if (current.status !== 'requested' || !current.providerPayoutId) return current;
      }
      // Soumission notée d'abord : quoi qu'il arrive ensuite, jamais un second lancement.
      const submitted = markSubmitted(current, this.deps.clock.now());
      if (!submitted) return current;
      const stored = await this.store(submitted.payout, submitted);
      if (stored.status !== 'processing' || stored.version !== current.version + 1) return stored;
      current = stored;
      stage = 'start';
      await provider.startPayout(current.providerPayoutId!);
      return current;
    } catch (error) {
      const httpStatus = rejectedStatus(error);
      if (httpStatus !== null) return this.reject(current, stage, httpStatus);
      if (!isOutage(error)) throw error;
      if (stage === 'start') {
        this.deps.alerts.payoutStartUncertain({
          payoutId: current.id,
          providerPayoutId: current.providerPayoutId!,
        });
      }
      return current;
    }
  }

  /** Refus définitif du prestataire : échec `provider_rejected` publié, alerte. */
  private async reject(payout: Payout, stage: 'create' | 'start', httpStatus: number): Promise<Payout> {
    const transition = rejectByProvider(payout, { httpStatus, now: this.deps.clock.now() });
    if (!transition) return payout;
    const saved = await this.store(transition.payout, transition);
    this.deps.alerts.payoutRejected({
      payoutId: payout.id,
      providerPayoutId: payout.providerPayoutId,
      stage,
      httpStatus,
    });
    return saved;
  }

  /**
   * Relit le reversement chez le prestataire et applique son statut. Montant ou devise différents :
   * statut ignoré et alerte (la finance vérifie).
   */
  async refresh(payout: Payout): Promise<Payout> {
    const provider = this.deps.payoutProvider;
    if (!provider.automatic || !payout.providerPayoutId) return payout;
    const remote = await provider.getPayout(payout.providerPayoutId);
    let current = payout;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const now = this.deps.clock.now();
      const consistent = remote.amount === current.amount && remote.currency.toUpperCase() === CURRENCY;
      if (!consistent) {
        this.deps.alerts.payoutMismatch({
          payoutId: current.id,
          providerPayoutId: remote.providerPayoutId,
          expectedAmount: current.amount,
          reportedAmount: remote.amount,
          currency: remote.currency,
        });
      }
      const transition = consistent
        ? applyProviderPayoutStatus(current, remote.status, { reference: remote.reference, now })
        : null;
      const next: Payout = { ...(transition ? transition.payout : current), lastCheckedAt: now };
      const events = transition ? payoutEvents({ ...transition, payout: next }) : [];
      if (await this.deps.payouts.save(next, events)) return { ...next, version: next.version + 1 };
      const reloaded = await this.deps.payouts.findById(current.id);
      if (!reloaded) throw PaymentErrors.payoutNotFound();
      current = reloaded;
    }
    throw PaymentErrors.concurrentUpdate();
  }

  /** Enregistre un nouvel état (et l'événement de sa transition, s'il y en a une). */
  async store(next: Payout, transition: PayoutTransition): Promise<Payout> {
    const events = transition ? payoutEvents({ ...transition, payout: next }) : [];
    if (await this.deps.payouts.save(next, events)) return { ...next, version: next.version + 1 };
    // Écriture concurrente (rapprochement et notification) : l'état enregistré fait foi.
    const reloaded = await this.deps.payouts.findById(next.id);
    if (!reloaded) throw PaymentErrors.payoutNotFound();
    return reloaded;
  }
}
