import { AppError } from '@ksp/platform';
import { CURRENCY } from '../domain/payment-intent';
import {
  applyProviderPayoutStatus,
  markSubmitted,
  type Payout,
  type PayoutTransition,
  recordProviderPayout,
} from '../domain/payout';
import { type OutboxMessage, type PaymentDeps } from './ports';
import { PaymentErrors } from './shared/errors';

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
          failureCode: payout.failureCode ?? 'provider_failed',
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
   * Reversement `requested` d'un prestataire automatique : créé chez lui s'il ne l'est pas, relu
   * (un lancement dont la réponse s'est perdue a pu aboutir), puis lancé s'il y attend encore. Une
   * panne laisse le reversement en l'état : le rapprochement planifié reprend. Mode manuel : rien.
   */
  async advance(payout: Payout): Promise<Payout> {
    const provider = this.deps.payoutProvider;
    if (!provider.automatic || payout.status !== 'requested') return payout;
    let current = payout;
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
      } else {
        current = await this.refresh(current);
        if (current.status !== 'requested') return current;
      }
      await provider.startPayout(current.providerPayoutId!);
      const submitted = markSubmitted(current, this.deps.clock.now());
      return submitted ? await this.store(submitted.payout, submitted) : current;
    } catch (error) {
      if (isOutage(error)) return current;
      throw error;
    }
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
