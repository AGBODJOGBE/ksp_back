import { type WalletEventPayloads, type WalletObjectRef } from '@ksp/contracts';
import { currentContext } from '@ksp/platform';
import {
  debitCounterpart,
  type Holder,
  type LedgerTransaction,
  type PaidObject,
  reversalEntries,
  sameDebit,
  serviceCreditEntries,
  servicePaymentEntries,
  topUpEntries,
} from '../domain/ledger';
import { type PrepaidSummary, type TopUpPayment, type WalletDeps, type WalletOutboxMessage } from './ports';
import {
  currentSpender,
  DEBIT_KEY,
  formatXof,
  IDEMPOTENCY_KEY,
  OBJECT_PART,
  OBJECT_TYPE,
  oneOf,
  requireCaller,
  requireHolder,
  requireText,
  requireUuid,
  requireXof,
  WalletErrors,
} from './shared';
import { transaction, WALLET } from './wallet.use-cases';

/**
 * Portefeuille prépayé des clients (ADR-046) : recharge par Mobile Money, débit par les services
 * (jamais partiel, jamais au-delà du solde), remboursement d'un débit, crédit manuel de la finance.
 * Toutes les écritures passent par le grand livre (ADR-042) : immuables, équilibrées, solde tenu par
 * la base sous verrou. Chaque écriture publie son événement dans la même transaction (outbox).
 */

const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

/** Libellé d'une recharge confirmée par payment. */
export const TOP_UP_DESCRIPTION = 'Recharge Mobile Money';

/** Destinataire des messages : le titulaire (compte), sinon le membre à l'origine de l'écriture. */
export function recipient(holder: Holder, actorId: string | null): string | null {
  return holder.type === 'user' ? holder.id : actorId;
}

/** Portefeuille du titulaire juste après une écriture (solde rendu par l'écriture elle-même). */
export async function prepaidAfter(
  deps: WalletDeps,
  t: LedgerTransaction,
  balance: number,
): Promise<PrepaidSummary> {
  return {
    holder: t.holder,
    balance,
    lastEntryAt: t.createdAt,
    withdrawalsInProgress: await deps.ledger.withdrawalsInProgress(t.holder),
  };
}

function debitedEvent(t: LedgerTransaction, balance: number): WalletOutboxMessage {
  const object = t.object!;
  return {
    type: 'wallet.prepaid.debited',
    payload: {
      transactionId: t.id,
      holder: { ...t.holder },
      userId: recipient(t.holder, t.actorId),
      amount: xof(t.amount),
      balanceAfter: xof(balance),
      service: t.caller,
      objectType: object.type,
      objectId: object.id,
      part: object.part,
      description: t.description,
      debitedAt: t.createdAt.toISOString(),
    },
  };
}

type CreditedPayload = WalletEventPayloads['wallet.prepaid.credited'];

/** Version de wallet.prepaid.credited publiée : la v2 seule (RV-101, consommateurs prêts). */
export const CREDITED_EVENT_VERSION = 2;

/**
 * wallet.prepaid.credited version 2 : la v1 plus le geste commercial (`commercial_gesture`), le moyen
 * d'une recharge (`topUpChannel`) et l'objet à régler aussitôt (`forObject`, paiement direct). Les
 * champs v2 absents ne sont pas écrits (tout message v1 est un message v2 valide).
 */
export function creditedEvent(
  t: LedgerTransaction,
  balance: number,
  input: {
    origin: 'payment' | 'service' | 'finance';
    userId: string | null;
    paymentId?: string;
    /** Par défaut : `top_up` pour une recharge, `refund` sinon. */
    kind?: CreditedPayload['kind'];
    topUpChannel?: CreditedPayload['topUpChannel'];
    forObject?: WalletObjectRef | null;
    /** Par défaut : débit annulé par l'écriture (remboursement en entier). */
    refundedTransactionId?: string | null;
  },
): WalletOutboxMessage {
  return {
    type: 'wallet.prepaid.credited',
    version: CREDITED_EVENT_VERSION,
    payload: {
      transactionId: t.id,
      kind: input.kind ?? (t.kind === 'top_up' ? 'top_up' : 'refund'),
      ...(input.topUpChannel ? { topUpChannel: input.topUpChannel } : {}),
      ...(input.forObject ? { forObject: { ...input.forObject } } : {}),
      origin: input.origin,
      holder: { ...t.holder },
      userId: input.userId,
      amount: xof(t.amount),
      balanceAfter: xof(balance),
      description: t.description,
      paymentId: input.paymentId ?? null,
      refundedTransactionId:
        input.refundedTransactionId === undefined ? t.reversesTransactionId : input.refundedTransactionId,
      creditedAt: t.createdAt.toISOString(),
    },
  };
}

/** Référence d'un débit : la clé de l'appelant, préfixée (aucune collision avec un remboursement). */
const debitReference = (key: string) => `debit:${key}`;
/** Une recharge Mobile Money n'est créditée qu'une fois, automatiquement ou par la finance. */
export const topUpReference = (paymentId: string) => `payment:${paymentId}`;

/**
 * Débit du portefeuille prépayé pour le paiement d'un service (WalletService.Debit). Jamais partiel :
 * solde insuffisant → WALLET_INSUFFICIENT_FUNDS avec le montant manquant, rien n'est écrit. Le solde
 * est contrôlé sous le verrou du compte, puis par la base (jamais négatif). Idempotent par
 * (appelant, clé) : le rejeu rend le même débit ; un débit déjà remboursé n'est jamais rejoué.
 * Contrepartie : `ksp:service_revenue`, sauf la provision versée au recouvrement (appelant `recovery`,
 * objet `recovery_provision`), tenue sur `ksp:recovery_provisions` (ADR-060, point 10) ; son
 * remboursement, écriture inverse, en repart.
 */
export class DebitPrepaidUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    idempotencyKey: string;
    holder: { type: string; id: string } | undefined;
    amount: { amount: number; currency: string } | undefined;
    object: { objectType: string; objectId: string; part: string } | undefined;
    description: string;
  }): Promise<{ transaction: LedgerTransaction; wallet: PrepaidSummary; created: boolean }> {
    const caller = requireCaller(this.deps.settings.debitCallers);
    if (!DEBIT_KEY.test(input.idempotencyKey)) {
      throw WalletErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 150 caractères).');
    }
    const holder = requireHolder('holder', input.holder);
    const amount = requireXof('amount', input.amount);
    const object = requireObject(input.object);
    const description = requireText('description', input.description, 140);
    const request = { holder, amount, object };
    const reference = debitReference(input.idempotencyKey);

    const replay = async (existing: LedgerTransaction) => {
      if (!sameDebit(existing, request)) throw WalletErrors.keyReused();
      if (await this.deps.ledger.findReversalOf(existing.id)) throw WalletErrors.debitRefunded();
      return { transaction: existing, wallet: await this.deps.ledger.prepaidSummary(holder), created: false };
    };
    const existing = await this.deps.ledger.findByReference(caller, reference);
    if (existing) return replay(existing);

    const debit = transaction(this.deps, {
      kind: 'service_payment',
      caller,
      reference,
      holder,
      amount,
      description,
      actorId: currentContext()?.user?.userId ?? null,
      object,
      entries: servicePaymentEntries(holder, amount, debitCounterpart(caller, object.type)),
    });
    const outcome = await this.deps.ledger.record({
      transaction: debit,
      requireHolderBalance: amount,
      events: (balance) => [debitedEvent(debit, balance)],
    });
    if (outcome.kind === 'insufficient') throw WalletErrors.insufficientFunds(outcome.balance, amount);
    if (outcome.kind === 'recorded') {
      return {
        transaction: debit,
        wallet: await prepaidAfter(this.deps, debit, outcome.holderBalance),
        created: true,
      };
    }
    // Envoi simultané de la même clé : le premier débit fait foi.
    const raced = await this.deps.ledger.findByReference(caller, reference);
    if (raced) return replay(raced);
    throw WalletErrors.concurrentUpdate();
  }
}

function requireObject(
  value: { objectType: string; objectId: string; part: string } | undefined,
): PaidObject {
  const type = value?.objectType ?? '';
  if (!OBJECT_TYPE.test(type)) throw WalletErrors.invalid('object.objectType', 'Type d’objet invalide.');
  const part = value?.part ? value.part : null;
  if (part !== null && !OBJECT_PART.test(part)) throw WalletErrors.invalid('object.part', 'Part invalide.');
  return { type, id: requireUuid('object.objectId', value?.objectId), part };
}

/**
 * Remboursement en entier d'un débit de l'appelant : écriture inverse, le montant est recrédité au
 * portefeuille depuis le compte que le débit avait crédité (`ksp:service_revenue`, ou
 * `ksp:recovery_provisions` pour une provision du recouvrement). Une seule fois : un second
 * remboursement rend le premier (`created: false`).
 */
async function refundDebit(
  deps: WalletDeps,
  caller: string,
  transactionId: string,
  reason: string | null,
): Promise<{ transaction: LedgerTransaction; wallet: PrepaidSummary; created: boolean }> {
  const original = await deps.ledger.findTransaction(requireUuid('transactionId', transactionId));
  if (!original || original.caller !== caller) throw WalletErrors.transactionNotFound();
  if (original.kind !== 'service_payment') throw WalletErrors.notRefundable();

  const done = async () => {
    const existing = await deps.ledger.findReversalOf(original.id);
    return existing
      ? { transaction: existing, wallet: await deps.ledger.prepaidSummary(original.holder), created: false }
      : null;
  };
  const already = await done();
  if (already) return already;

  const description = `Remboursement — ${original.description}${reason ? ` (${reason})` : ''}`;
  const refund = transaction(deps, {
    kind: 'refund',
    caller,
    reference: `refund:${original.id}`,
    holder: original.holder,
    amount: original.amount,
    description: description.slice(0, 200),
    reversesTransactionId: original.id,
    object: original.object,
    entries: reversalEntries(original),
  });
  const outcome = await deps.ledger.record({
    transaction: refund,
    events: (balance) => [
      creditedEvent(refund, balance, {
        origin: 'service',
        userId: recipient(original.holder, original.actorId),
      }),
    ],
  });
  if (outcome.kind === 'recorded') {
    return {
      transaction: refund,
      wallet: await prepaidAfter(deps, refund, outcome.holderBalance),
      created: true,
    };
  }
  const raced = await done();
  if (raced) return raced;
  throw WalletErrors.concurrentUpdate();
}

/** WalletService.Refund : remboursement d'un débit, demandé par le service qui l'a fait. */
export class RefundDebitUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { transactionId: string; reason: string }) {
    const caller = requireCaller(this.deps.settings.debitCallers);
    const reason = requireText('reason', input.reason, 200);
    return refundDebit(this.deps, caller, input.transactionId, reason);
  }
}

/** Sortes de crédit décidé par un service (CreditRequest.kind). */
export const SERVICE_CREDIT_KINDS = ['commercial_gesture', 'refund'] as const;
type ServiceCreditKind = (typeof SERVICE_CREDIT_KINDS)[number];

/**
 * WalletService.Credit (CDC Nettoyage v2, R-WL-04, R-RC-03) : crédit au portefeuille décidé par un
 * service de WALLET_CREDIT_CALLERS, sans débit à rembourser en entier (geste commercial, crédit d'une
 * réclamation, remboursement d'une part de séance). Le service a fait ses contrôles (double
 * validation au-delà de 50 000 FCFA pour une réclamation). Écriture `service_credit`, contrepartie
 * `ksp:service_revenue`, objet d'origine gardé. Idempotent par (appelant, clé) : le rejeu rend le même
 * crédit, une autre demande avec la même clé est refusée. Débit d'origine facultatif : un paiement de
 * service de l'appelant, pour ce titulaire ; repris dans l'événement (`refundedTransactionId`), sans
 * colonne propre dans le grand livre.
 */
export class CreditByServiceUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    idempotencyKey: string;
    holder: { type: string; id: string } | undefined;
    amount: { amount: number; currency: string } | undefined;
    object: { objectType: string; objectId: string; part: string } | undefined;
    kind: string;
    description: string;
    relatedTransactionId: string;
  }): Promise<{ transaction: LedgerTransaction; wallet: PrepaidSummary; created: boolean }> {
    const caller = requireCaller(this.deps.settings.creditCallers);
    if (!DEBIT_KEY.test(input.idempotencyKey)) {
      throw WalletErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 150 caractères).');
    }
    const holder = requireHolder('holder', input.holder);
    const amount = requireXof('amount', input.amount);
    const object = requireObject(input.object);
    const kind = oneOf<ServiceCreditKind>('kind', input.kind, SERVICE_CREDIT_KINDS);
    const description = requireText('description', input.description, 140);
    const relatedId = input.relatedTransactionId
      ? requireUuid('relatedTransactionId', input.relatedTransactionId)
      : null;
    const reference = `credit:${input.idempotencyKey}`;

    const replay = async (existing: LedgerTransaction) => {
      const same =
        existing.kind === 'service_credit' &&
        existing.holder.type === holder.type &&
        existing.holder.id === holder.id &&
        existing.amount === amount &&
        existing.object?.type === object.type &&
        existing.object.id === object.id &&
        existing.object.part === object.part;
      if (!same) throw WalletErrors.keyReused();
      return { transaction: existing, wallet: await this.deps.ledger.prepaidSummary(holder), created: false };
    };
    const existing = await this.deps.ledger.findByReference(caller, reference);
    if (existing) return replay(existing);

    if (relatedId) {
      const related = await this.deps.ledger.findTransaction(relatedId);
      const ownDebit =
        related?.kind === 'service_payment' &&
        related.caller === caller &&
        related.holder.type === holder.type &&
        related.holder.id === holder.id;
      if (!ownDebit) throw WalletErrors.transactionNotFound();
    }

    const actorId = currentContext()?.user?.userId ?? null;
    const credit = transaction(this.deps, {
      kind: 'service_credit',
      caller,
      reference,
      holder,
      amount,
      description,
      actorId,
      object,
      entries: serviceCreditEntries(holder, amount),
    });
    const outcome = await this.deps.ledger.record({
      transaction: credit,
      events: (balance) => [
        creditedEvent(credit, balance, {
          origin: 'service',
          userId: recipient(holder, actorId),
          kind,
          refundedTransactionId: relatedId,
        }),
      ],
    });
    if (outcome.kind === 'recorded') {
      return {
        transaction: credit,
        wallet: await prepaidAfter(this.deps, credit, outcome.holderBalance),
        created: true,
      };
    }
    const raced = await this.deps.ledger.findByReference(caller, reference);
    if (raced) return replay(raced);
    throw WalletErrors.concurrentUpdate();
  }
}

/** Motif d'un débit remboursé par le rapprochement. */
export const UNRECORDED_DEBIT_REASON = 'paiement non enregistré par le service';

/**
 * Tâche planifiée (ADR-048) : débits du portefeuille plus anciens que le délai réglable, ni vérifiés
 * ni remboursés, rapprochés avec le service qui les a faits (« débit enregistré ? »). Enregistré :
 * noté vérifié. Non enregistré (panne entre le débit et l'enregistrement du paiement) : remboursé au
 * portefeuille, une seule fois, avec une alerte. Opération encore en cours chez l'appelant (RV-80) :
 * redemandée au passage suivant, jamais remboursée. Service injoignable : laissé pour le prochain
 * passage, jamais remboursé à l'aveugle. Une erreur sur un débit n'empêche pas l'examen des suivants.
 */
export class ReconcileDebitsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(limit = 50): Promise<{
    examined: number;
    recorded: number;
    refunded: number;
    inProgress: number;
    errors: number;
  }> {
    const before = new Date(
      this.deps.clock.now().getTime() - this.deps.settings.debitCheckDelayMinutes * 60_000,
    );
    const debits = await this.deps.ledger.listUncheckedDebits(before, limit);
    const counts = { examined: debits.length, recorded: 0, refunded: 0, inProgress: 0, errors: 0 };
    for (const debit of debits) {
      try {
        if (!debit.object) continue;
        const status = await this.deps.debitChecks.debitStatus({
          caller: debit.caller,
          objectType: debit.object.type,
          objectId: debit.object.id,
          transactionId: debit.id,
        });
        if (status === null) continue;
        if (status === 'in_progress') {
          counts.inProgress += 1;
          continue;
        }
        if (status === 'recorded') {
          await this.deps.ledger.markDebitChecked(debit.id, 'recorded', this.deps.clock.now());
          counts.recorded += 1;
          continue;
        }
        await refundDebit(this.deps, debit.caller, debit.id, UNRECORDED_DEBIT_REASON);
        await this.deps.ledger.markDebitChecked(debit.id, 'refunded', this.deps.clock.now());
        counts.refunded += 1;
      } catch {
        counts.errors += 1;
      }
    }
    return counts;
  }
}

/** WalletService.GetPrepaidBalance : solde prépayé d'un titulaire, pour un service appelant. */
export class GetPrepaidBalanceUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(holder: { type: string; id: string } | undefined): Promise<PrepaidSummary> {
    requireCaller(this.deps.settings.debitCallers);
    return this.deps.ledger.prepaidSummary(requireHolder('holder', holder));
  }
}

/**
 * Recharge du portefeuille du connecté (son compte, ou son organisation active s'il y est
 * org_admin ou org_member) : montant entre les limites réglables, puis paiement Mobile Money créé
 * par payment (objet wallet_top_up, payeur transmis dans les métadonnées). Rien n'est écrit ici : le
 * portefeuille est crédité à la confirmation du paiement (payment.intent.succeeded).
 */
export class CreateTopUpUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    idempotencyKey: string;
    amount: { amount: number; currency: string } | undefined;
  }): Promise<{ topUp: TopUpPayment & { holder: Holder }; created: boolean }> {
    const { holder } = currentSpender();
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw WalletErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const amount = requireXof('amount', input.amount);
    const { topUpMin, topUpMax } = this.deps.settings;
    if (amount < topUpMin || amount > topUpMax) {
      throw WalletErrors.invalid(
        'amount',
        `Montant de recharge attendu entre ${formatXof(topUpMin)} et ${formatXof(topUpMax)}.`,
      );
    }
    const payment = await this.deps.topUps.create({ idempotencyKey: input.idempotencyKey, amount });
    return { topUp: { ...payment, holder }, created: payment.created };
  }
}

/**
 * `rejected` : le paiement relu chez payment ne confirme pas l'événement (pas réussi, autre
 * titulaire, autre montant reçu) : rien n'est crédité (ADR-048).
 */
export type TopUpCreditOutcome = 'recorded' | 'duplicate' | 'ignored' | 'rejected';

/**
 * payment.intent.succeeded d'une recharge (objet wallet_top_up) : le portefeuille du titulaire
 * (l'organisation payeuse, sinon le payeur) est crédité du montant confirmé par le prestataire. Une
 * seule fois par paiement : inbox dans la même transaction, et référence `payment:<id>` unique (un
 * crédit manuel de la finance pour ce paiement l'aurait déjà fait). Objet incohérent : ignoré.
 * Avant tout crédit, le paiement est relu chez payment (ADR-048) : il doit être réussi, pour ce
 * titulaire, et le montant reçu égal à celui de l'événement ; sinon rien n'est crédité (`rejected`).
 * payment injoignable : erreur, l'événement est réessayé.
 */
export class CreditTopUpUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    eventId: string;
    eventType: string;
    paymentId: string;
    subjectId: string;
    customerId: string;
    organizationId: string | null;
    amount: number;
    /** Paiement direct (v2, R-WL-05) : objet que la recharge doit régler aussitôt. */
    target?: { service: string; objectType: string; objectId: string; part: string | null } | null;
  }): Promise<TopUpCreditOutcome> {
    const holder: Holder = input.organizationId
      ? { type: 'organization', id: input.organizationId }
      : { type: 'user', id: input.customerId };
    if (input.subjectId !== holder.id) return 'ignored';
    const reference = topUpReference(input.paymentId);
    if (await this.deps.ledger.findByReference(WALLET, reference)) return 'duplicate';
    const payment = await this.deps.topUps.get(input.paymentId);
    const confirmed =
      payment !== null &&
      payment.status === 'succeeded' &&
      payment.holderId === holder.id &&
      payment.organizationId === input.organizationId &&
      payment.receivedAmount === input.amount;
    if (!confirmed) return 'rejected';
    const credit = transaction(this.deps, {
      kind: 'top_up',
      caller: WALLET,
      reference,
      holder,
      amount: input.amount,
      description: TOP_UP_DESCRIPTION,
      actorId: input.customerId,
      entries: topUpEntries(holder, input.amount),
    });
    const outcome = await this.deps.ledger.record({
      transaction: credit,
      inbox: { eventId: input.eventId, consumer: `wallet.${input.eventType}` },
      events: (balance) => [
        creditedEvent(credit, balance, {
          origin: 'payment',
          userId: recipient(holder, input.customerId),
          paymentId: input.paymentId,
          // Recharge en ligne par payment : Mobile Money (seul moyen publié par payment.intent.succeeded).
          topUpChannel: 'mobile_money_online',
          forObject: input.target
            ? {
                service: input.target.service,
                objectType: input.target.objectType,
                objectId: input.target.objectId,
                part: input.target.part,
              }
            : null,
        }),
      ],
    });
    if (outcome.kind === 'recorded') return 'recorded';
    if (outcome.kind === 'already_processed' || outcome.kind === 'duplicate') return 'duplicate';
    throw WalletErrors.concurrentUpdate();
  }
}
