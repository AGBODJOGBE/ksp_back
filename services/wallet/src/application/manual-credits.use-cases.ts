import { type Holder, type LedgerTransaction, refundEntries, topUpEntries } from '../domain/ledger';
import {
  type CreditKind,
  type ManualCreditRequest,
  type ManualCreditStatus,
  type PageRequest,
  type PageResult,
  type PrepaidSummary,
  type WalletDeps,
} from './ports';
import { creditedEvent, prepaidAfter, recipient, topUpReference } from './prepaid.use-cases';
import {
  CREDIT_MFA_MAX_AGE_SECONDS,
  IDEMPOTENCY_KEY,
  oneOf,
  requireHolder,
  requireStaff,
  requireText,
  requireUuid,
  requireXof,
  WalletErrors,
} from './shared';
import { transaction, WALLET } from './wallet.use-cases';

/** Crédits manuels de la finance. */
export const CREDIT_KINDS: readonly CreditKind[] = ['refund', 'top_up'];
export const CREDIT_REQUEST_STATUSES: readonly ManualCreditStatus[] = ['pending_approval', 'approved'];
/** Justification d'un remboursement manuel : 15 caractères au moins (ADR-048). */
export const REFUND_REASON_MIN = 15;

/** Statuts de payment d'une recharge dont l'argent est reçu : réussie, ou écart de montant. */
const RECEIVED_STATUSES = ['succeeded', 'amount_mismatch'];

type CreditResult = {
  transaction: LedgerTransaction | null;
  wallet: PrepaidSummary;
  created: boolean;
  pendingRequest: ManualCreditRequest | null;
};

/** Crédit à écrire : référence d'idempotence et auteur de la demande. */
interface CreditOrder {
  holder: Holder;
  kind: CreditKind;
  amount: number;
  reason: string;
  paymentId: string | null;
  reference: string;
  actorId: string;
}

/** Même crédit (rejeu) : sorte, titulaire, montant et auteur identiques. */
function sameCredit(existing: LedgerTransaction, order: CreditOrder): boolean {
  return (
    existing.kind === order.kind &&
    existing.holder.type === order.holder.type &&
    existing.holder.id === order.holder.id &&
    existing.amount === order.amount &&
    existing.actorId === order.actorId
  );
}

/**
 * Écrit le crédit dans le grand livre (immuable), avec son événement. Idempotent par sa référence :
 * `credit:<clé>` (remboursement) ou `payment:<id>` (recharge, une seule fois par paiement, automatique
 * ou manuelle).
 */
async function writeCredit(
  deps: WalletDeps,
  order: CreditOrder,
): Promise<{ transaction: LedgerTransaction; wallet: PrepaidSummary; created: boolean }> {
  const replay = async (existing: LedgerTransaction) => {
    if (!sameCredit(existing, order)) {
      throw order.kind === 'top_up' ? WalletErrors.topUpAlreadyCredited() : WalletErrors.keyReused();
    }
    return { transaction: existing, wallet: await deps.ledger.prepaidSummary(order.holder), created: false };
  };
  const existing = await deps.ledger.findByReference(WALLET, order.reference);
  if (existing) return replay(existing);
  const credit = transaction(deps, {
    kind: order.kind,
    caller: WALLET,
    reference: order.reference,
    holder: order.holder,
    amount: order.amount,
    description: order.reason,
    actorId: order.actorId,
    entries:
      order.kind === 'top_up'
        ? topUpEntries(order.holder, order.amount)
        : refundEntries(order.holder, order.amount),
  });
  const outcome = await deps.ledger.record({
    transaction: credit,
    events: (balance) => [
      creditedEvent(credit, balance, {
        origin: 'finance',
        userId: recipient(order.holder, null),
        ...(order.paymentId ? { paymentId: order.paymentId } : {}),
      }),
    ],
  });
  if (outcome.kind === 'recorded') {
    return { transaction: credit, wallet: prepaidAfter(credit, outcome.holderBalance), created: true };
  }
  const raced = await deps.ledger.findByReference(WALLET, order.reference);
  if (raced) return replay(raced);
  throw WalletErrors.concurrentUpdate();
}

/**
 * Recharge créditée à la main : vérifiée auprès de payment (ADR-048). Le paiement doit être une
 * recharge (`wallet_top_up`) du même titulaire, dont l'argent est reçu (réussie, ou écart de montant
 * en XOF), et le crédit ne dépasse jamais le montant reçu.
 */
async function verifyTopUp(deps: WalletDeps, paymentId: string, holder: Holder, amount: number) {
  const payment = await deps.topUps.get(paymentId);
  if (!payment) throw WalletErrors.topUpNotVerified('payment_not_found');
  const expectedOrganization = holder.type === 'organization' ? holder.id : null;
  if (payment.holderId !== holder.id || payment.organizationId !== expectedOrganization) {
    throw WalletErrors.topUpNotVerified('other_holder');
  }
  if (!RECEIVED_STATUSES.includes(payment.status) || payment.receivedAmount === null) {
    throw WalletErrors.topUpNotVerified('not_received');
  }
  if (amount > payment.receivedAmount) throw WalletErrors.topUpNotVerified('exceeds_received');
}

/**
 * Back-office (finance, double authentification de moins de 10 minutes) : crédit manuel d'un
 * portefeuille prépayé avec motif, l'auteur gardé dans le grand livre (immuable). `refund` :
 * remboursement (service non rendu, geste commercial), plafonné et justifié ; `top_up` : recharge reçue
 * par Mobile Money mais non créditée (écart de montant traité par la finance), vérifiée auprès de
 * payment, une seule fois par paiement. Au-delà du seuil de double validation, rien n'est écrit : une
 * demande attend un second membre de la finance (ADR-048). Idempotent par clé.
 */
export class CreditPrepaidWalletUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    idempotencyKey: string;
    holder: { type: string; id: string } | undefined;
    kind: string;
    amount: { amount: number; currency: string } | undefined;
    reason: string;
    paymentId: string;
  }): Promise<CreditResult> {
    const staff = requireStaff(CREDIT_MFA_MAX_AGE_SECONDS);
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw WalletErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const holder = requireHolder('holder', input.holder);
    const kind = oneOf('kind', input.kind, CREDIT_KINDS);
    const amount = requireXof('amount', input.amount);
    const reason = requireText('reason', input.reason, 200);
    let paymentId: string | null = null;
    if (kind === 'top_up') {
      paymentId = requireUuid('paymentId', input.paymentId);
    } else {
      if (input.paymentId)
        throw WalletErrors.invalid('paymentId', 'Un remboursement ne cite pas de paiement.');
      if (reason.length < REFUND_REASON_MIN) {
        throw WalletErrors.invalid(
          'reason',
          `Justification attendue : ${REFUND_REASON_MIN} caractères au moins.`,
        );
      }
    }
    const order: CreditOrder = {
      holder,
      kind,
      amount,
      reason,
      paymentId,
      reference: paymentId ? topUpReference(paymentId) : `credit:${input.idempotencyKey}`,
      actorId: staff.userId,
    };

    // Rejeu : crédit déjà écrit, ou demande déjà enregistrée avec cette clé.
    const written = await this.deps.ledger.findByReference(WALLET, order.reference);
    if (written) return { ...(await writeCredit(this.deps, order)), pendingRequest: null };
    const requested = await this.deps.creditRequests.findByKey(input.idempotencyKey);
    if (requested) return this.replayRequest(requested, order);

    if (kind === 'refund' && amount > this.deps.settings.manualRefundMax) {
      throw WalletErrors.creditLimitExceeded(this.deps.settings.manualRefundMax);
    }
    if (paymentId) await verifyTopUp(this.deps, paymentId, holder, amount);

    if (amount > this.deps.settings.creditApprovalThreshold) {
      const stored = await this.deps.creditRequests.create({
        id: this.deps.ids.next(),
        idempotencyKey: input.idempotencyKey,
        holder,
        kind,
        amount,
        reason,
        paymentId,
        status: 'pending_approval',
        requestedBy: staff.userId,
        requestedAt: this.deps.clock.now(),
        approvedBy: null,
        approvedAt: null,
        transactionId: null,
        version: 0,
      });
      if (!stored.created) return this.replayRequest(stored.request, order);
      return {
        transaction: null,
        wallet: await this.deps.ledger.prepaidSummary(holder),
        created: true,
        pendingRequest: stored.request,
      };
    }
    return { ...(await writeCredit(this.deps, order)), pendingRequest: null };
  }

  /** Même clé : la même demande (validée ou non) ; une demande différente est refusée. */
  private async replayRequest(request: ManualCreditRequest, order: CreditOrder): Promise<CreditResult> {
    const same =
      request.holder.type === order.holder.type &&
      request.holder.id === order.holder.id &&
      request.kind === order.kind &&
      request.amount === order.amount &&
      request.paymentId === order.paymentId &&
      request.requestedBy === order.actorId;
    if (!same) throw WalletErrors.keyReused();
    const credit = request.transactionId
      ? await this.deps.ledger.findTransaction(request.transactionId)
      : null;
    return {
      transaction: credit,
      wallet: await this.deps.ledger.prepaidSummary(request.holder),
      created: false,
      pendingRequest: credit ? null : request,
    };
  }
}

/**
 * Back-office : validation d'un crédit manuel par un second membre de la finance (jamais l'auteur de
 * la demande), double authentification de moins de 10 minutes. Le crédit est écrit (auteur : celui
 * de la demande ; validation gardée sur la demande) ; une recharge est revérifiée auprès de payment.
 * Rejouable : une demande validée rend son crédit.
 */
export class ApproveManualCreditUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(requestId: string): Promise<{
    transaction: LedgerTransaction;
    wallet: PrepaidSummary;
    request: ManualCreditRequest;
    created: boolean;
  }> {
    const staff = requireStaff(CREDIT_MFA_MAX_AGE_SECONDS);
    const request = await this.deps.creditRequests.findById(requireUuid('requestId', requestId));
    if (!request) throw WalletErrors.creditRequestNotFound();
    if (request.requestedBy === staff.userId) throw WalletErrors.approvalByRequester();
    const order: CreditOrder = {
      holder: request.holder,
      kind: request.kind,
      amount: request.amount,
      reason: request.reason,
      paymentId: request.paymentId,
      reference: request.paymentId ? topUpReference(request.paymentId) : `credit:${request.idempotencyKey}`,
      actorId: request.requestedBy,
    };
    if (request.status === 'pending_approval' && request.paymentId) {
      await verifyTopUp(this.deps, request.paymentId, request.holder, request.amount);
    }
    const credit = await writeCredit(this.deps, order);
    let current = request;
    if (current.status === 'pending_approval') {
      const approved: ManualCreditRequest = {
        ...current,
        status: 'approved',
        approvedBy: staff.userId,
        approvedAt: this.deps.clock.now(),
        transactionId: credit.transaction.id,
      };
      // Validation simultanée : celle qui est enregistrée fait foi (même crédit, même référence).
      current = (await this.deps.creditRequests.save(approved))
        ? { ...approved, version: approved.version + 1 }
        : ((await this.deps.creditRequests.findById(request.id)) ?? approved);
    }
    return { ...credit, request: current, created: credit.created };
  }
}

/** Back-office : demandes de crédit manuel, les plus récentes d'abord, filtrables par statut. */
export class ListManualCreditRequestsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { page: PageRequest; status: string }): Promise<PageResult<ManualCreditRequest>> {
    requireStaff();
    const status = input.status ? oneOf('status', input.status, CREDIT_REQUEST_STATUSES) : undefined;
    return this.deps.creditRequests.list(status ? { status } : {}, input.page);
  }
}
