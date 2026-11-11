import { currentContext } from '@ksp/platform';
import {
  type Holder,
  type LedgerTransaction,
  type PaidObject,
  refundEntries,
  reversalEntries,
  sameDebit,
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

export function prepaidAfter(t: LedgerTransaction, balance: number): PrepaidSummary {
  return { holder: t.holder, balance, lastEntryAt: t.createdAt };
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

export function creditedEvent(
  t: LedgerTransaction,
  balance: number,
  input: {
    origin: 'payment' | 'service' | 'finance';
    userId: string | null;
    paymentId?: string;
  },
): WalletOutboxMessage {
  return {
    type: 'wallet.prepaid.credited',
    payload: {
      transactionId: t.id,
      kind: t.kind === 'top_up' ? 'top_up' : 'refund',
      origin: input.origin,
      holder: { ...t.holder },
      userId: input.userId,
      amount: xof(t.amount),
      balanceAfter: xof(balance),
      description: t.description,
      paymentId: input.paymentId ?? null,
      refundedTransactionId: t.reversesTransactionId,
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
      entries: servicePaymentEntries(holder, amount),
    });
    const outcome = await this.deps.ledger.record({
      transaction: debit,
      requireHolderBalance: amount,
      events: (balance) => [debitedEvent(debit, balance)],
    });
    if (outcome.kind === 'insufficient') throw WalletErrors.insufficientFunds(outcome.balance, amount);
    if (outcome.kind === 'recorded') {
      return { transaction: debit, wallet: prepaidAfter(debit, outcome.holderBalance), created: true };
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
 * portefeuille. Une seule fois : un second remboursement rend le premier (`created: false`).
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
    return { transaction: refund, wallet: prepaidAfter(refund, outcome.holderBalance), created: true };
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

/**
 * cleaning.mission.refunded (ADR-046) : chaque débit cité est remboursé, une seule fois (un
 * événement rejoué ne rembourse rien de plus). Émetteur hors de WALLET_DEBIT_CALLERS : ignoré.
 */
export class RefundFromEventUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    producer: string;
    transactionIds: readonly string[];
    reason: string;
  }): Promise<{ refunded: number; already: number } | 'ignored'> {
    if (!this.deps.settings.debitCallers.includes(input.producer)) return 'ignored';
    const counts = { refunded: 0, already: 0 };
    for (const id of input.transactionIds) {
      const result = await refundDebit(this.deps, input.producer, id, input.reason);
      if (result.created) counts.refunded += 1;
      else counts.already += 1;
    }
    return counts;
  }
}

/** Motif d'un débit remboursé par le rapprochement. */
export const UNRECORDED_DEBIT_REASON = 'paiement non enregistré par le service';

/**
 * Tâche planifiée (ADR-048) : débits du portefeuille plus anciens que le délai réglable, ni vérifiés
 * ni remboursés, rapprochés avec le service qui les a faits (« débit enregistré ? »). Enregistré :
 * noté vérifié. Non enregistré (panne entre le débit et l'enregistrement du paiement) : remboursé au
 * portefeuille, une seule fois, avec une alerte. Service injoignable : laissé pour le prochain
 * passage, jamais remboursé à l'aveugle. Une erreur sur un débit n'empêche pas l'examen des suivants.
 */
export class ReconcileDebitsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(
    limit = 50,
  ): Promise<{ examined: number; recorded: number; refunded: number; errors: number }> {
    const before = new Date(
      this.deps.clock.now().getTime() - this.deps.settings.debitCheckDelayMinutes * 60_000,
    );
    const debits = await this.deps.ledger.listUncheckedDebits(before, limit);
    const counts = { examined: debits.length, recorded: 0, refunded: 0, errors: 0 };
    for (const debit of debits) {
      try {
        if (!debit.object) continue;
        const recorded = await this.deps.debitChecks.isRecorded({
          caller: debit.caller,
          objectType: debit.object.type,
          objectId: debit.object.id,
          transactionId: debit.id,
        });
        if (recorded === null) continue;
        if (recorded) {
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

/** Émetteur de cleaning.mission.credited. */
const CLEANING = 'cleaning';

/**
 * cleaning.mission.credited (ADR-049) : montant payé pour des passages non faits d'une mission
 * récurrente arrêtée, crédité au portefeuille prépayé du client (écriture `refund`, quel que soit le
 * moyen de paiement d'origine). Une seule fois par crédit : référence `mission-credit:<creditId>`
 * propre à cleaning, et inbox dans la même transaction. Émetteur autre que cleaning : ignoré.
 */
export class CreditFromMissionUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    eventId: string;
    eventType: string;
    producer: string;
    missionId: string;
    customerId: string;
    creditId: string;
    amount: number;
  }): Promise<'recorded' | 'duplicate' | 'ignored'> {
    if (input.producer !== CLEANING || !this.deps.settings.debitCallers.includes(CLEANING)) return 'ignored';
    const holder: Holder = { type: 'user', id: requireUuid('customerId', input.customerId) };
    const amount = requireXof('amount', { amount: input.amount, currency: 'XOF' });
    const reference = `mission-credit:${requireUuid('creditId', input.creditId)}`;
    if (await this.deps.ledger.findByReference(CLEANING, reference)) return 'duplicate';
    const credit = transaction(this.deps, {
      kind: 'refund',
      caller: CLEANING,
      reference,
      holder,
      amount,
      description: 'Remboursement au prorata — passages non effectués',
      object: { type: 'cleaning_mission', id: requireUuid('missionId', input.missionId), part: null },
      entries: refundEntries(holder, amount),
    });
    const outcome = await this.deps.ledger.record({
      transaction: credit,
      inbox: { eventId: input.eventId, consumer: `wallet.${input.eventType}` },
      events: (balance) => [creditedEvent(credit, balance, { origin: 'service', userId: holder.id })],
    });
    if (outcome.kind === 'recorded') return 'recorded';
    if (outcome.kind === 'already_processed' || outcome.kind === 'duplicate') return 'duplicate';
    throw WalletErrors.concurrentUpdate();
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
        }),
      ],
    });
    if (outcome.kind === 'recorded') return 'recorded';
    if (outcome.kind === 'already_processed' || outcome.kind === 'duplicate') return 'duplicate';
    throw WalletErrors.concurrentUpdate();
  }
}
