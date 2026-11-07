import { MAX_AMOUNT } from '../domain/payment-link';
import {
  BENIN_PHONE,
  PAYOUT_OPERATORS,
  PAYOUT_STATUSES,
  type Payout,
  type PayoutBeneficiary,
  type PayoutOperator,
  settleManually,
} from '../domain/payout';
import { type PageRequest, type PageResult, type PaymentDeps } from './ports';
import { PAYOUT_STAFF, requireIssuer, requireStaff } from './shared/access';
import { PaymentErrors } from './shared/errors';
import {
  IDEMPOTENCY_KEY,
  oneOf,
  optionalIdempotencyKey,
  optionalOneOf,
  requireText,
  requireUuid,
  requireXof,
} from './shared/validation';
import { PayoutSync } from './payout-sync';

const ISSUER = /^[a-z][a-z0-9-]*$/;

/** Même demande (rejeu) : montant et bénéficiaire identiques. */
function sameRequest(payout: Payout, amount: number, beneficiary: PayoutBeneficiary): boolean {
  return (
    payout.amount === amount &&
    payout.beneficiary.phone === beneficiary.phone &&
    payout.beneficiary.operator === beneficiary.operator
  );
}

/**
 * Demande de reversement par un service autorisé (wallet, ADR-039) : idempotente par (émetteur, clé).
 * Le reversement est enregistré `requested`, puis lancé aussitôt chez le prestataire automatique ;
 * une panne n'empêche pas l'enregistrement (le rapprochement planifié le lancera). Mode manuel : il
 * attend la confirmation de la finance au back-office.
 */
export class RequestPayoutUseCase {
  private readonly sync: PayoutSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PayoutSync(deps);
  }

  async execute(input: {
    idempotencyKey: string;
    reference: string;
    amount: { amount: number; currency: string } | undefined;
    beneficiary: { phone: string; operator: string; name: string } | undefined;
  }): Promise<{ payout: Payout; created: boolean }> {
    const issuer = requireIssuer(this.deps.settings.payoutIssuers);
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw PaymentErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const reference = requireText('reference', input.reference, 100);
    const amount = requireXof('amount', input.amount, MAX_AMOUNT);
    const phone = input.beneficiary?.phone ?? '';
    if (!BENIN_PHONE.test(phone)) {
      throw PaymentErrors.invalid(
        'beneficiary.phone',
        'Numéro béninois au format international attendu (+229…).',
      );
    }
    const beneficiary: PayoutBeneficiary = {
      phone,
      operator: oneOf<PayoutOperator>(
        'beneficiary.operator',
        input.beneficiary?.operator ?? '',
        PAYOUT_OPERATORS,
      ),
      name: requireText('beneficiary.name', input.beneficiary?.name, 120),
    };

    const replay = await this.deps.payouts.findByIssuerKey(issuer, input.idempotencyKey);
    if (replay) {
      if (!sameRequest(replay, amount, beneficiary)) throw PaymentErrors.keyReused();
      return { payout: await this.sync.advance(replay), created: false };
    }
    const now = this.deps.clock.now();
    const stored = await this.deps.payouts.create({
      id: this.deps.ids.next(),
      issuer,
      idempotencyKey: input.idempotencyKey,
      reference,
      amount,
      beneficiary,
      status: 'requested',
      provider: this.deps.payoutProvider.name,
      providerPayoutId: null,
      providerReference: null,
      failureCode: null,
      failureReason: null,
      settledBy: null,
      settlementKey: null,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      completedAt: null,
      failedAt: null,
      lastCheckedAt: null,
      version: 0,
    });
    if (!stored.created && !sameRequest(stored.payout, amount, beneficiary)) throw PaymentErrors.keyReused();
    return { payout: await this.sync.advance(stored.payout), created: stored.created };
  }
}

/** Reversement vu par son émetteur ; celui d'un autre émetteur reste introuvable. */
export class GetPayoutUseCase {
  constructor(private readonly deps: PaymentDeps) {}

  async execute(payoutId: string): Promise<Payout> {
    const issuer = requireIssuer(this.deps.settings.payoutIssuers);
    const payout = await this.deps.payouts.findById(requireUuid('payoutId', payoutId));
    if (!payout || payout.issuer !== issuer) throw PaymentErrors.payoutNotFound();
    return payout;
  }
}

/** Back-office : reversements, les plus récents d'abord, filtrables par statut et émetteur. */
export class ListPayoutsUseCase {
  constructor(private readonly deps: PaymentDeps) {}

  async execute(input: { page: PageRequest; status: string; issuer: string }): Promise<PageResult<Payout>> {
    requireStaff(PAYOUT_STAFF);
    const status = optionalOneOf('status', input.status, PAYOUT_STATUSES);
    if (input.issuer && !ISSUER.test(input.issuer)) throw PaymentErrors.invalid('issuer');
    return this.deps.payouts.list(
      { ...(status ? { status } : {}), ...(input.issuer ? { issuer: input.issuer } : {}) },
      input.page,
    );
  }
}

/**
 * Back-office, mode manuel : la finance a fait le virement (`completed`, référence obligatoire) ou n'a
 * pas pu le faire (`failed`, raison obligatoire). L'issue est publiée (outbox) ; wallet solde ou rend
 * le montant. Rejouable sans effet (même clé, ou même compte, même issue et même texte).
 */
export class SettlePayoutUseCase {
  private readonly sync: PayoutSync;

  constructor(
    private readonly deps: PaymentDeps,
    private readonly outcome: 'completed' | 'failed',
  ) {
    this.sync = new PayoutSync(deps);
  }

  async execute(input: { payoutId: string; text: string; idempotencyKey: string }): Promise<Payout> {
    const staff = requireStaff(PAYOUT_STAFF);
    const payoutId = requireUuid('payoutId', input.payoutId);
    const text =
      this.outcome === 'completed'
        ? requireText('transferReference', input.text, 100)
        : requireText('reason', input.text, 500);
    const request = {
      outcome: this.outcome,
      text,
      by: staff.userId,
      idempotencyKey: optionalIdempotencyKey(input.idempotencyKey),
    };
    const payout = await this.deps.payouts.findById(payoutId);
    if (!payout) throw PaymentErrors.payoutNotFound();
    const decision = settleManually(payout, { ...request, now: this.deps.clock.now() });
    if (decision.kind === 'replay') return payout;
    if (decision.kind === 'refused') {
      throw decision.reason === 'not_manual'
        ? PaymentErrors.payoutNotManual()
        : PaymentErrors.payoutAlreadySettled();
    }
    const saved = await this.sync.store(decision.transition.payout, decision.transition);
    if (saved.version === payout.version + 1 && saved.status === this.outcome) return saved;
    // Écriture concurrente : rejouée si c'était la même décision, sinon refusée.
    const again = settleManually(saved, { ...request, now: this.deps.clock.now() });
    if (again.kind === 'replay') return saved;
    throw PaymentErrors.payoutAlreadySettled();
  }
}

/**
 * Tâche planifiée (prestataire automatique) : reversements `requested` créés ou lancés chez le
 * prestataire, reversements `processing` relus (notification perdue). Une erreur sur un reversement
 * n'empêche pas l'examen des suivants. Mode manuel : rien à faire.
 */
export class ReconcilePayoutsUseCase {
  private readonly sync: PayoutSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PayoutSync(deps);
  }

  async execute(
    limit = 50,
  ): Promise<{ examined: number; completed: number; failed: number; errors: number }> {
    const provider = this.deps.payoutProvider;
    const counts = { examined: 0, completed: 0, failed: 0, errors: 0 };
    if (!provider.automatic) return counts;
    const now = this.deps.clock.now();
    const payouts = await this.deps.payouts.listToReconcile({
      provider: provider.name,
      checkedBefore: new Date(now.getTime() - this.deps.settings.recheckAfterSeconds * 1000),
      limit,
    });
    counts.examined = payouts.length;
    for (const payout of payouts) {
      try {
        const current =
          payout.status === 'requested' ? await this.sync.advance(payout) : await this.sync.refresh(payout);
        if (current.status === 'completed') counts.completed += 1;
        else if (current.status === 'failed') counts.failed += 1;
      } catch {
        counts.errors += 1;
      }
    }
    return counts;
  }
}
