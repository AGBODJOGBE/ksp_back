import {
  collectionEntries,
  type LedgerTransaction,
  MAX_RATE_BPS,
  payoutHoldEntries,
  payoutReleaseEntries,
  payoutSettlementEntries,
  reversalEntries,
  sameCollection,
} from '../domain/ledger';
import {
  BENIN_PHONE,
  isSettled,
  markSubmitted,
  maskPhone,
  type Operator,
  OPERATORS,
  settle,
  type WalletPayout,
  WALLET_PAYOUT_STATUSES,
} from '../domain/wallet-payout';
import {
  type LedgerOverview,
  type PageRequest,
  type PageResult,
  type StatementLine,
  type WalletDeps,
  type WalletSummary,
} from './ports';
import {
  currentHolder,
  IDEMPOTENCY_KEY,
  oneOf,
  REFERENCE,
  requireCaller,
  requireHolder,
  requireStaff,
  requireText,
  requireUuid,
  requireXof,
  statementAccounts,
  WalletErrors,
} from './shared';

/** Écritures propres à wallet (retenue, solde, restitution d'un reversement, recharges, crédits). */
export const WALLET = 'wallet';

/** Champs facultatifs d'une écriture, nuls par défaut. */
type OptionalFields =
  | 'grossAmount'
  | 'commission'
  | 'commissionRateBps'
  | 'reversesTransactionId'
  | 'payoutId'
  | 'actorId'
  | 'object';

/** Nouvelle écriture : identifiant, date et champs facultatifs nuls. */
export function transaction(
  deps: WalletDeps,
  fields: Omit<LedgerTransaction, 'id' | 'createdAt' | OptionalFields> &
    Partial<Pick<LedgerTransaction, OptionalFields>>,
): LedgerTransaction {
  return {
    id: deps.ids.next(),
    createdAt: deps.clock.now(),
    grossAmount: null,
    commission: null,
    commissionRateBps: null,
    reversesTransactionId: null,
    payoutId: null,
    actorId: null,
    object: null,
    ...fields,
  };
}

/**
 * Encaissement reçu pour un titulaire (ADR-042) : le net lui est crédité, la commission (taux fourni
 * par l'appelant, arrondie à l'entier inférieur) revient à KSP. Idempotent par (appelant, référence) :
 * le rejeu rend la même transaction ; une référence déjà utilisée pour autre chose est refusée.
 */
export class RecordCollectionUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    holder: { type: string; id: string } | undefined;
    grossAmount: { amount: number; currency: string } | undefined;
    commissionRateBps: number;
    reference: string;
    description: string;
  }): Promise<{ transaction: LedgerTransaction; wallet: WalletSummary; created: boolean }> {
    const caller = requireCaller(this.deps.settings.ledgerCallers);
    const holder = requireHolder('holder', input.holder);
    const gross = requireXof('grossAmount', input.grossAmount);
    const rateBps = input.commissionRateBps;
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_RATE_BPS) {
      throw WalletErrors.invalid('commissionRateBps', 'Taux en points de base attendu, de 0 à 10 000.');
    }
    if (!REFERENCE.test(input.reference)) throw WalletErrors.invalid('reference', 'Référence invalide.');
    const description = requireText('description', input.description, 140);
    const request = { holder, gross, rateBps };

    const replay = async (existing: LedgerTransaction) => {
      if (!sameCollection(existing, request)) throw WalletErrors.keyReused();
      return { transaction: existing, wallet: await this.deps.ledger.summary(holder), created: false };
    };
    const existing = await this.deps.ledger.findByReference(caller, input.reference);
    if (existing) return replay(existing);

    const { net, commission, entries } = collectionEntries(holder, gross, rateBps);
    const outcome = await this.deps.ledger.record({
      transaction: transaction(this.deps, {
        kind: 'collection',
        caller,
        reference: input.reference,
        holder,
        amount: net,
        grossAmount: gross,
        commission,
        commissionRateBps: rateBps,
        description,
        entries,
      }),
    });
    if (outcome.kind === 'recorded') {
      return {
        transaction: outcome.transaction,
        wallet: await this.deps.ledger.summary(holder),
        created: true,
      };
    }
    // Envoi simultané de la même référence : la première écriture fait foi.
    const raced = await this.deps.ledger.findByReference(caller, input.reference);
    if (raced) return replay(raced);
    throw WalletErrors.concurrentUpdate();
  }
}

/** Transmet un reversement à payment ; une panne le laisse en attente (nouvel essai planifié). */
async function submit(deps: WalletDeps, payout: WalletPayout): Promise<WalletPayout> {
  if (payout.status !== 'pending_submission' || !payout.beneficiaryPhone || !payout.beneficiaryName) {
    return payout;
  }
  const { payoutId } = await deps.executor.request({
    idempotencyKey: payout.id,
    reference: payout.id,
    amount: payout.amount,
    beneficiary: {
      phone: payout.beneficiaryPhone,
      operator: payout.beneficiaryOperator,
      name: payout.beneficiaryName,
    },
  });
  const next = markSubmitted(payout, payoutId, deps.clock.now());
  if (next && (await deps.payouts.save(next))) return { ...next, version: next.version + 1 };
  // Issue déjà reçue entre-temps (événement plus rapide que la réponse) : l'état enregistré fait foi.
  return (await deps.payouts.findById(payout.id)) ?? payout;
}

async function trySubmit(deps: WalletDeps, payout: WalletPayout): Promise<WalletPayout> {
  try {
    return await submit(deps, payout);
  } catch {
    return payout;
  }
}

/**
 * Reversement demandé depuis le solde d'un titulaire : le montant est retenu (jamais au-delà du solde
 * disponible, contrôlé sous verrou) dans la même transaction que la création du reversement, puis
 * transmis à payment, qui l'exécute. payment injoignable : le reversement reste
 * `pending_submission` et la tâche planifiée le transmet. Idempotent par (appelant, clé).
 */
export class RequestPayoutUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    idempotencyKey: string;
    holder: { type: string; id: string } | undefined;
    amount: { amount: number; currency: string } | undefined;
    beneficiary: { phone: string; operator: string; name: string } | undefined;
  }): Promise<{ payout: WalletPayout; wallet: WalletSummary; created: boolean }> {
    const caller = requireCaller(this.deps.settings.ledgerCallers);
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw WalletErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const holder = requireHolder('holder', input.holder);
    const amount = requireXof('amount', input.amount);
    const phone = input.beneficiary?.phone ?? '';
    if (!BENIN_PHONE.test(phone)) {
      throw WalletErrors.invalid(
        'beneficiary.phone',
        'Numéro béninois au format international attendu (+229…).',
      );
    }
    const operator = oneOf<Operator>('beneficiary.operator', input.beneficiary?.operator ?? '', OPERATORS);
    const name = requireText('beneficiary.name', input.beneficiary?.name, 120);

    const replay = async (existing: WalletPayout) => {
      const same =
        existing.holder.type === holder.type &&
        existing.holder.id === holder.id &&
        existing.amount === amount &&
        existing.beneficiaryOperator === operator &&
        existing.beneficiaryPhoneMasked === maskPhone(phone);
      if (!same) throw WalletErrors.keyReused();
      const payout = await trySubmit(this.deps, existing);
      return { payout, wallet: await this.deps.ledger.summary(holder), created: false };
    };
    const existing = await this.deps.payouts.findByKey(caller, input.idempotencyKey);
    if (existing) return replay(existing);

    const now = this.deps.clock.now();
    const payoutId = this.deps.ids.next();
    const hold = transaction(this.deps, {
      kind: 'payout_hold',
      caller: WALLET,
      reference: `payout:${payoutId}`,
      holder,
      amount,
      description: 'Reversement Mobile Money',
      payoutId,
      entries: payoutHoldEntries(holder, amount),
    });
    const payout: WalletPayout = {
      id: payoutId,
      caller,
      idempotencyKey: input.idempotencyKey,
      holder,
      amount,
      status: 'pending_submission',
      beneficiaryPhone: phone,
      beneficiaryName: name,
      beneficiaryPhoneMasked: maskPhone(phone),
      beneficiaryOperator: operator,
      paymentPayoutId: null,
      holdTransactionId: hold.id,
      settlementTransactionId: null,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      completedAt: null,
      failedAt: null,
      version: 0,
    };
    const outcome = await this.deps.ledger.record({
      transaction: hold,
      requireHolderBalance: amount,
      createPayout: payout,
    });
    if (outcome.kind === 'insufficient') throw WalletErrors.insufficientBalance(outcome.balance);
    if (outcome.kind !== 'recorded') {
      const raced = await this.deps.payouts.findByKey(caller, input.idempotencyKey);
      if (raced) return replay(raced);
      throw WalletErrors.concurrentUpdate();
    }
    const submitted = await trySubmit(this.deps, payout);
    return { payout: submitted, wallet: await this.deps.ledger.summary(holder), created: true };
  }
}

/** Tâche planifiée : reversements pas encore transmis à payment (panne au premier essai). */
export class SubmitPendingPayoutsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(limit = 20): Promise<{ examined: number; submitted: number; errors: number }> {
    const pending = await this.deps.payouts.listPendingSubmission(limit);
    const counts = { examined: pending.length, submitted: 0, errors: 0 };
    for (const payout of pending) {
      try {
        const next = await submit(this.deps, payout);
        if (next.status !== 'pending_submission') counts.submitted += 1;
      } catch {
        counts.errors += 1;
      }
    }
    return counts;
  }
}

/**
 * Annulation d'un encaissement par écriture inverse (encaissement enregistré à tort, remboursé au
 * débiteur…) : mêmes comptes, sens opposés ; la commission est rendue. Le solde du titulaire peut
 * devenir négatif si l'encaissement a déjà été reversé : c'est alors une dette du titulaire, et aucun
 * reversement n'est possible avant régularisation. Une seule annulation par encaissement ; rejouable
 * par sa référence.
 */
export class ReverseTransactionUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    transactionId: string;
    reason: string;
    reference: string;
  }): Promise<{ transaction: LedgerTransaction; wallet: WalletSummary; created: boolean }> {
    const caller = requireCaller(this.deps.settings.ledgerCallers);
    const original = await this.deps.ledger.findTransaction(
      requireUuid('transactionId', input.transactionId),
    );
    if (!original) throw WalletErrors.transactionNotFound();
    // Retenues et soldes de reversement (écritures de wallet) : jamais annulés par un appelant.
    if (original.kind !== 'collection') throw WalletErrors.notReversible();
    if (original.caller !== caller) throw WalletErrors.transactionNotFound();
    if (!REFERENCE.test(input.reference)) throw WalletErrors.invalid('reference', 'Référence invalide.');
    const reason = requireText('reason', input.reason, 200);

    const replay = async () => {
      const existing = await this.deps.ledger.findByReference(caller, input.reference);
      if (!existing) return null;
      if (existing.kind !== 'reversal' || existing.reversesTransactionId !== original.id) {
        throw WalletErrors.keyReused();
      }
      return {
        transaction: existing,
        wallet: await this.deps.ledger.summary(original.holder),
        created: false,
      };
    };
    const replayed = await replay();
    if (replayed) return replayed;
    if (await this.deps.ledger.findReversalOf(original.id)) throw WalletErrors.alreadyReversed();

    const outcome = await this.deps.ledger.record({
      transaction: transaction(this.deps, {
        kind: 'reversal',
        caller,
        reference: input.reference,
        holder: original.holder,
        amount: original.amount,
        grossAmount: original.grossAmount,
        commission: original.commission,
        commissionRateBps: original.commissionRateBps,
        description: reason,
        reversesTransactionId: original.id,
        entries: reversalEntries(original),
      }),
    });
    if (outcome.kind === 'recorded') {
      return {
        transaction: outcome.transaction,
        wallet: await this.deps.ledger.summary(original.holder),
        created: true,
      };
    }
    const raced = await replay();
    if (raced) return raced;
    throw WalletErrors.alreadyReversed();
  }
}

/** Solde et relevé d'un titulaire, pour un service appelant (recovery). */
export class GetBalanceUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(holder: { type: string; id: string } | undefined): Promise<WalletSummary> {
    requireCaller(this.deps.settings.ledgerCallers);
    return this.deps.ledger.summary(requireHolder('holder', holder));
  }
}

/** Relevé des fonds dus à un titulaire (créancier), pour un service appelant (recovery). */
export class ListStatementUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(
    holder: { type: string; id: string } | undefined,
    page: PageRequest,
  ): Promise<PageResult<StatementLine>> {
    requireCaller(this.deps.settings.ledgerCallers);
    return this.deps.ledger.statement(requireHolder('holder', holder), ['collections'], page);
  }
}

/**
 * Espace du titulaire connecté : son compte, ou son organisation active ; fonds dus et portefeuille
 * prépayé, avec les montants de recharge acceptés.
 */
export class GetMyWalletUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(): Promise<{ wallet: WalletSummary; topUpLimits: { min: number; max: number } }> {
    const { topUpMin, topUpMax } = this.deps.settings;
    return {
      wallet: await this.deps.ledger.summary(currentHolder()),
      topUpLimits: { min: topUpMin, max: topUpMax },
    };
  }
}

/** Relevé du connecté : ses deux comptes (les plus récentes d'abord), ou celui demandé. */
export class ListMyStatementUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { page: PageRequest; account: string }): Promise<PageResult<StatementLine>> {
    const accounts = statementAccounts(input.account);
    return this.deps.ledger.statement(currentHolder(), accounts, input.page);
  }
}

export class ListMyPayoutsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { page: PageRequest; status: string }): Promise<PageResult<WalletPayout>> {
    const holder = currentHolder();
    const status = input.status ? oneOf('status', input.status, WALLET_PAYOUT_STATUSES) : undefined;
    return this.deps.payouts.list({ holder, ...(status ? { status } : {}) }, input.page);
  }
}

/** Back-office (finance) : portefeuille et relevé d'un titulaire, reversements, vue d'ensemble. */
export class GetHolderWalletUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(holder: { type: string; id: string } | undefined): Promise<WalletSummary> {
    requireStaff();
    return this.deps.ledger.summary(requireHolder('holder', holder));
  }
}

export class ListHolderStatementUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    holder: { type: string; id: string } | undefined;
    page: PageRequest;
    account: string;
  }): Promise<PageResult<StatementLine>> {
    requireStaff();
    const holder = requireHolder('holder', input.holder);
    return this.deps.ledger.statement(holder, statementAccounts(input.account), input.page);
  }
}

export class ListWalletPayoutsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    page: PageRequest;
    status: string;
    holder: { type: string; id: string } | undefined;
  }): Promise<PageResult<WalletPayout>> {
    requireStaff();
    const status = input.status ? oneOf('status', input.status, WALLET_PAYOUT_STATUSES) : undefined;
    const holder = input.holder?.type || input.holder?.id ? requireHolder('holder', input.holder) : undefined;
    return this.deps.payouts.list(
      { ...(status ? { status } : {}), ...(holder ? { holder } : {}) },
      input.page,
    );
  }
}

export class GetLedgerOverviewUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(): Promise<LedgerOverview> {
    requireStaff();
    return this.deps.ledger.overview();
  }
}

export type PayoutSettlementOutcome = 'recorded' | 'duplicate' | 'ignored' | 'amount_mismatch';

/**
 * payment.payout.completed / failed : le reversement wallet (référence = son identifiant) est soldé.
 * Terminé : le montant en transit sort des fonds détenus ; en échec : il est rendu au titulaire.
 * L'écriture, le reversement et l'inbox sont enregistrés ensemble : un événement reçu deux fois n'a
 * qu'un effet. Reversement d'un autre émetteur ou inconnu : ignoré. Montant différent : rien n'est
 * écrit (alerte côté consommateur).
 */
export class SettlePayoutUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    eventId: string;
    eventType: string;
    outcome: 'completed' | 'failed';
    paymentPayoutId: string;
    issuer: string;
    reference: string;
    amount: number;
  }): Promise<PayoutSettlementOutcome> {
    if (input.issuer !== WALLET) return 'ignored';
    const payoutId = /^[0-9a-f-]{36}$/i.test(input.reference) ? input.reference.toLowerCase() : null;
    const payout = payoutId ? await this.deps.payouts.findById(payoutId) : null;
    if (!payout) return 'ignored';
    if (isSettled(payout.status)) return 'duplicate';
    if (input.amount !== payout.amount) return 'amount_mismatch';
    const settlement = transaction(this.deps, {
      kind: input.outcome === 'completed' ? 'payout_settlement' : 'payout_release',
      caller: WALLET,
      reference: `${input.outcome === 'completed' ? 'payout-settlement' : 'payout-release'}:${payout.id}`,
      holder: payout.holder,
      amount: payout.amount,
      description:
        input.outcome === 'completed' ? 'Reversement effectué' : 'Reversement en échec : montant rendu',
      payoutId: payout.id,
      entries:
        input.outcome === 'completed'
          ? payoutSettlementEntries(payout.amount)
          : payoutReleaseEntries(payout.holder, payout.amount),
    });
    const next = settle(payout, {
      outcome: input.outcome,
      paymentPayoutId: input.paymentPayoutId,
      settlementTransactionId: settlement.id,
      now: this.deps.clock.now(),
    })!;
    const outcome = await this.deps.ledger.record({
      transaction: settlement,
      updatePayout: next,
      inbox: { eventId: input.eventId, consumer: `wallet.${input.eventType}` },
    });
    if (outcome.kind === 'recorded') return 'recorded';
    if (outcome.kind === 'already_processed' || outcome.kind === 'duplicate') return 'duplicate';
    // Reversement modifié en même temps (transmission notée) : l'événement sera réessayé.
    throw WalletErrors.concurrentUpdate();
  }
}
