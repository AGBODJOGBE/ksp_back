import { type WalletObjectRef } from '@ksp/contracts';
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
  OBJECT_PART,
  OBJECT_TYPE,
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
export const CREDIT_KINDS: readonly CreditKind[] = [
  'refund',
  'top_up',
  'cash_top_up',
  'bank_transfer_top_up',
];
export const CREDIT_REQUEST_STATUSES: readonly ManualCreditStatus[] = [
  'pending_approval',
  'approved',
  'rejected',
];
/** Versements reçus hors ligne (espèces, virement) : reçu obligatoire, toujours une double validation. */
const OFFLINE_KINDS: readonly CreditKind[] = ['cash_top_up', 'bank_transfer_top_up'];
/** Service qui débite l'objet d'un versement (forObject.service). */
const SERVICE_NAME = /^[a-z]+$/;

/** Écriture du grand livre d'un crédit manuel : remboursement, ou recharge (argent reçu par KSP). */
function ledgerKind(kind: CreditKind): 'refund' | 'top_up' {
  return kind === 'refund' ? 'refund' : 'top_up';
}

/** Moyen de la recharge publié dans wallet.prepaid.credited v2 ; absent pour un remboursement. */
function topUpChannel(kind: CreditKind) {
  if (kind === 'cash_top_up') return 'cash' as const;
  if (kind === 'bank_transfer_top_up') return 'bank_transfer' as const;
  return kind === 'top_up' ? ('mobile_money_online' as const) : undefined;
}

/** Objet à régler aussitôt (forObject), facultatif : service, type, identifiant et part. */
function optionalForObject(
  value: { service?: string; objectType?: string; objectId?: string; part?: string } | undefined,
): WalletObjectRef | null {
  if (!value || (!value.service && !value.objectType && !value.objectId && !value.part)) return null;
  if (!SERVICE_NAME.test(value.service ?? '')) {
    throw WalletErrors.invalid('forObject.service', 'Service attendu (minuscules).');
  }
  if (!OBJECT_TYPE.test(value.objectType ?? '')) {
    throw WalletErrors.invalid('forObject.objectType', 'Type d’objet invalide.');
  }
  const part = value.part ? value.part : null;
  if (part !== null && !OBJECT_PART.test(part))
    throw WalletErrors.invalid('forObject.part', 'Part invalide.');
  return {
    service: value.service!,
    objectType: value.objectType!,
    objectId: requireUuid('forObject.objectId', value.objectId),
    part,
  };
}
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
  forObject: WalletObjectRef | null;
}

/** Même crédit (rejeu) : sorte, titulaire, montant et auteur identiques. */
function sameCredit(existing: LedgerTransaction, order: CreditOrder): boolean {
  return (
    existing.kind === ledgerKind(order.kind) &&
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
  const kind = ledgerKind(order.kind);
  const credit = transaction(deps, {
    kind,
    caller: WALLET,
    reference: order.reference,
    holder: order.holder,
    amount: order.amount,
    description: order.reason,
    actorId: order.actorId,
    entries:
      kind === 'top_up'
        ? topUpEntries(order.holder, order.amount)
        : refundEntries(order.holder, order.amount),
  });
  const channel = topUpChannel(order.kind);
  const outcome = await deps.ledger.record({
    transaction: credit,
    events: (balance) => [
      creditedEvent(credit, balance, {
        origin: 'finance',
        userId: recipient(order.holder, null),
        ...(order.paymentId ? { paymentId: order.paymentId } : {}),
        ...(channel ? { topUpChannel: channel } : {}),
        forObject: order.forObject,
      }),
    ],
  });
  if (outcome.kind === 'recorded') {
    return {
      transaction: credit,
      wallet: await prepaidAfter(deps, credit, outcome.holderBalance),
      created: true,
    };
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
    /** v2 : espèces ou virement, référence du reçu (obligatoire pour eux seuls). */
    receiptReference?: string | undefined;
    /** v2 : objet à régler aussitôt, facultatif (versement reçu, pas un remboursement). */
    forObject?: { service?: string; objectType?: string; objectId?: string; part?: string } | undefined;
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
    } else if (input.paymentId) {
      throw WalletErrors.invalid('paymentId', 'Seule une recharge Mobile Money cite un paiement.');
    }
    const offline = OFFLINE_KINDS.includes(kind);
    let receiptReference: string | null = null;
    if (offline) {
      receiptReference = requireText('receiptReference', input.receiptReference, 100);
    } else if (input.receiptReference) {
      throw WalletErrors.invalid('receiptReference', 'Seuls les espèces et les virements ont un reçu.');
    }
    const forObject = optionalForObject(input.forObject);
    if (kind === 'refund') {
      if (forObject) throw WalletErrors.invalid('forObject', 'Un remboursement ne règle aucun objet.');
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
      forObject,
    };

    // Rejeu : crédit déjà écrit, ou demande déjà enregistrée avec cette clé.
    const written = await this.deps.ledger.findByReference(WALLET, order.reference);
    if (written) return { ...(await writeCredit(this.deps, order)), pendingRequest: null };
    const requested = await this.deps.creditRequests.findByKey(input.idempotencyKey);
    if (requested) return this.replayRequest(requested, order, receiptReference);

    if (kind === 'refund' && amount > this.deps.settings.manualRefundMax) {
      throw WalletErrors.creditLimitExceeded(this.deps.settings.manualRefundMax);
    }
    if (paymentId) await verifyTopUp(this.deps, paymentId, holder, amount);

    // Espèces et virements : toujours validés par une deuxième personne (R-WL-02), quel que soit le montant.
    if (offline || amount > this.deps.settings.creditApprovalThreshold) {
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
        receiptReference,
        forObject,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        version: 0,
      });
      if (!stored.created) return this.replayRequest(stored.request, order, receiptReference);
      return {
        transaction: null,
        wallet: await this.deps.ledger.prepaidSummary(holder),
        created: true,
        pendingRequest: stored.request,
      };
    }
    return { ...(await writeCredit(this.deps, order)), pendingRequest: null };
  }

  /**
   * Même clé : la même demande (en attente, validée ou rejetée) ; une demande différente est refusée.
   * Une demande rejetée est rendue telle quelle, sans crédit.
   */
  private async replayRequest(
    request: ManualCreditRequest,
    order: CreditOrder,
    receiptReference: string | null,
  ): Promise<CreditResult> {
    const same =
      request.holder.type === order.holder.type &&
      request.holder.id === order.holder.id &&
      request.kind === order.kind &&
      request.amount === order.amount &&
      request.paymentId === order.paymentId &&
      request.receiptReference === receiptReference &&
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
    if (request.status === 'rejected') throw WalletErrors.creditRequestNotPending(request.status);
    if (request.requestedBy === staff.userId) throw WalletErrors.approvalByRequester();
    const order: CreditOrder = {
      holder: request.holder,
      kind: request.kind,
      amount: request.amount,
      reason: request.reason,
      paymentId: request.paymentId,
      reference: request.paymentId ? topUpReference(request.paymentId) : `credit:${request.idempotencyKey}`,
      actorId: request.requestedBy,
      forObject: request.forObject,
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

/**
 * Back-office : rejet motivé d'une demande de crédit en attente (recharge en espèces non retrouvée en
 * caisse…), double authentification de moins de 10 minutes. Rien n'est crédité. L'auteur peut rejeter
 * sa propre demande pour l'annuler (à valider). Demande validée ou déjà rejetée :
 * WALLET_CREDIT_REQUEST_NOT_PENDING.
 */
export class RejectManualCreditUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { requestId: string; reason: string }): Promise<{ request: ManualCreditRequest }> {
    const staff = requireStaff(CREDIT_MFA_MAX_AGE_SECONDS);
    const id = requireUuid('requestId', input.requestId);
    const reason = requireText('reason', input.reason, 200);
    const request = await this.deps.creditRequests.findById(id);
    if (!request) throw WalletErrors.creditRequestNotFound();
    if (request.status !== 'pending_approval') throw WalletErrors.creditRequestNotPending(request.status);
    const rejected: ManualCreditRequest = {
      ...request,
      status: 'rejected',
      rejectedBy: staff.userId,
      rejectedAt: this.deps.clock.now(),
      rejectionReason: reason,
    };
    if (await this.deps.creditRequests.save(rejected)) {
      return { request: { ...rejected, version: rejected.version + 1 } };
    }
    // Validée ou rejetée en même temps : l'état enregistré fait foi.
    const current = await this.deps.creditRequests.findById(id);
    throw WalletErrors.creditRequestNotPending(current?.status ?? request.status);
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
