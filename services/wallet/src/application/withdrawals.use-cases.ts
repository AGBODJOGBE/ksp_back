import { hasRole, requireUser } from '@ksp/platform';
import {
  withdrawalHoldEntries,
  withdrawalReleaseEntries,
  withdrawalSettlementEntries,
} from '../domain/ledger';
import { maskPhone, type Operator, OPERATORS, parseBeninPhone } from '../domain/wallet-payout';
import {
  approveWithdrawal,
  markWithdrawalSubmitted,
  processWithdrawal,
  rejectWithdrawal,
  settleWithdrawal,
  type Withdrawal,
  WITHDRAWAL_STATUSES,
  type WithdrawalStatus,
  withdrawalPayoutReference,
} from '../domain/withdrawal';
import { type PageRequest, type PageResult, type PrepaidSummary, type WalletDeps } from './ports';
import {
  CREDIT_MFA_MAX_AGE_SECONDS,
  currentHolder,
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

/**
 * Retrait du portefeuille prépayé vers Mobile Money (CDC Nettoyage v2, R-WL-04 ; ADR-055, décision 8) :
 * demandé par le titulaire, traité par la finance, validé par une deuxième personne, exécuté par
 * payment (PayoutService, mécanisme des reversements d'ADR-041). Chaque mouvement d'argent est une
 * écriture du grand livre enregistrée avec le retrait (retenue, sortie, restitution).
 */

type WithdrawalResult = { withdrawal: Withdrawal; wallet: PrepaidSummary };

/**
 * Le retrait (ou son montant) touche l'argent du titulaire : double authentification de moins de
 * 10 minutes pour le traiter, le valider ou le refuser, comme pour un crédit manuel.
 */
const WITHDRAWAL_MFA_MAX_AGE_SECONDS = CREDIT_MFA_MAX_AGE_SECONDS;

async function requireWithdrawal(deps: WalletDeps, id: string): Promise<Withdrawal> {
  const withdrawal = await deps.withdrawals.findById(requireUuid('withdrawalId', id));
  if (!withdrawal) throw WalletErrors.withdrawalNotFound();
  return withdrawal;
}

/**
 * Titulaire connecté autorisé à retirer : lui-même, ou son organisation active s'il en est
 * administrateur (org_admin, R-CP-03).
 */
function currentWithdrawer() {
  const user = requireUser();
  const holder = currentHolder();
  if (holder.type === 'organization' && !hasRole(user, 'org_admin', { type: 'org', id: holder.id })) {
    throw WalletErrors.withdrawalAdminRequired();
  }
  return { holder, userId: user.userId };
}

/**
 * WalletAccountService.RequestWithdrawal : le montant est retenu aussitôt (écriture `withdrawal_hold`,
 * jamais au-delà du solde, contrôlé sous le verrou du portefeuille) dans la même transaction que la
 * création du retrait. Idempotent par (titulaire, clé) : même demande rendue, autre demande refusée.
 */
export class RequestWithdrawalUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    idempotencyKey: string;
    amount: { amount: number; currency: string } | undefined;
    beneficiary: { phone: string; operator: string; name: string } | undefined;
  }): Promise<WithdrawalResult & { created: boolean }> {
    const { holder, userId } = currentWithdrawer();
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw WalletErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const amount = requireXof('amount', input.amount);
    const phone = parseBeninPhone(input.beneficiary?.phone ?? '');
    if (phone === null) {
      throw WalletErrors.invalid(
        'beneficiary.phone',
        'Numéro béninois au format international attendu (+229…).',
      );
    }
    const operator = oneOf<Operator>('beneficiary.operator', input.beneficiary?.operator ?? '', OPERATORS);
    const name = requireText('beneficiary.name', input.beneficiary?.name, 120);
    const fingerprint = this.deps.fingerprints.of(phone);

    const replay = async (existing: Withdrawal) => {
      const same =
        existing.amount === amount &&
        existing.beneficiaryOperator === operator &&
        existing.beneficiaryPhoneHash === fingerprint;
      if (!same) throw WalletErrors.keyReused();
      return { withdrawal: existing, wallet: await this.deps.ledger.prepaidSummary(holder), created: false };
    };
    const existing = await this.deps.withdrawals.findByKey(holder, input.idempotencyKey);
    if (existing) return replay(existing);

    const now = this.deps.clock.now();
    const id = this.deps.ids.next();
    const hold = transaction(this.deps, {
      kind: 'withdrawal_hold',
      caller: WALLET,
      reference: `withdrawal:${id}`,
      holder,
      amount,
      description: 'Retrait vers Mobile Money',
      actorId: userId,
      entries: withdrawalHoldEntries(holder, amount),
    });
    const withdrawal: Withdrawal = {
      id,
      idempotencyKey: input.idempotencyKey,
      holder,
      amount,
      status: 'requested',
      beneficiaryPhone: phone,
      beneficiaryName: name,
      beneficiaryPhoneMasked: maskPhone(phone),
      beneficiaryPhoneHash: fingerprint,
      beneficiaryOperator: operator,
      requestedBy: userId,
      requestedAt: now,
      processedBy: null,
      processedAt: null,
      processingNote: null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      paymentPayoutId: null,
      holdTransactionId: hold.id,
      settlementTransactionId: null,
      completedAt: null,
      failedAt: null,
      updatedAt: now,
      version: 0,
    };
    const outcome = await this.deps.ledger.record({
      transaction: hold,
      requireHolderBalance: amount,
      createWithdrawal: withdrawal,
    });
    if (outcome.kind === 'insufficient') throw WalletErrors.insufficientFunds(outcome.balance, amount);
    if (outcome.kind !== 'recorded') {
      const raced = await this.deps.withdrawals.findByKey(holder, input.idempotencyKey);
      if (raced) return replay(raced);
      throw WalletErrors.concurrentUpdate();
    }
    return { withdrawal, wallet: await this.deps.ledger.prepaidSummary(holder), created: true };
  }
}

/** Retraits du titulaire connecté (son compte, ou son organisation active), les plus récents d'abord. */
export class ListMyWithdrawalsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { page: PageRequest; status: string }): Promise<PageResult<Withdrawal>> {
    const holder = currentHolder();
    const status = input.status
      ? oneOf<WithdrawalStatus>('status', input.status, WITHDRAWAL_STATUSES)
      : undefined;
    return this.deps.withdrawals.list({ holder, ...(status ? { status } : {}) }, input.page, 'newest');
  }
}

/** Back-office (finance) : demandes de retrait, les plus anciennes d'abord, filtres facultatifs. */
export class ListWithdrawalsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: {
    page: PageRequest;
    status: string;
    holder: { type: string; id: string } | undefined;
  }): Promise<PageResult<Withdrawal>> {
    requireStaff();
    const status = input.status
      ? oneOf<WithdrawalStatus>('status', input.status, WITHDRAWAL_STATUSES)
      : undefined;
    const holder = input.holder?.id ? requireHolder('holder', input.holder) : undefined;
    return this.deps.withdrawals.list(
      { ...(status ? { status } : {}), ...(holder ? { holder } : {}) },
      input.page,
      'oldest',
    );
  }
}

/** Première personne de la finance : vérifications faites (titulaire, numéro), note obligatoire. */
export class ProcessWithdrawalUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { withdrawalId: string; note: string }): Promise<{ withdrawal: Withdrawal }> {
    const staff = requireStaff(WITHDRAWAL_MFA_MAX_AGE_SECONDS);
    const note = requireText('note', input.note, 500);
    const withdrawal = await requireWithdrawal(this.deps, input.withdrawalId);
    const next = processWithdrawal(withdrawal, { staffId: staff.userId, note, now: this.deps.clock.now() });
    if (!next) throw WalletErrors.withdrawalInvalidTransition(withdrawal.status);
    if (!(await this.deps.withdrawals.save(next))) {
      const current = await requireWithdrawal(this.deps, withdrawal.id);
      throw WalletErrors.withdrawalInvalidTransition(current.status);
    }
    return { withdrawal: { ...next, version: next.version + 1 } };
  }
}

/**
 * Deuxième personne de la finance (jamais celle qui a traité) : la validation est notée, puis le
 * virement est transmis à payment (clé : identifiant du retrait, référence `wallet_withdrawal:<id>`).
 * payment injoignable : l'erreur est rendue, la validation reste notée et un nouvel appel transmet
 * le retrait. Rejouable : un retrait déjà transmis ou terminé est rendu tel quel.
 */
export class ApproveWithdrawalUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { withdrawalId: string }): Promise<{ withdrawal: Withdrawal }> {
    const staff = requireStaff(WITHDRAWAL_MFA_MAX_AGE_SECONDS);
    let withdrawal = await requireWithdrawal(this.deps, input.withdrawalId);
    if (withdrawal.processedBy === staff.userId) throw WalletErrors.approvalByProcessor();
    if (['submitted', 'completed', 'failed'].includes(withdrawal.status)) return { withdrawal };
    if (withdrawal.status !== 'awaiting_approval') {
      throw WalletErrors.withdrawalInvalidTransition(withdrawal.status);
    }
    if (withdrawal.approvedBy === null) {
      const approved = approveWithdrawal(withdrawal, { staffId: staff.userId, now: this.deps.clock.now() });
      if (!approved) throw WalletErrors.withdrawalInvalidTransition(withdrawal.status);
      withdrawal = (await this.deps.withdrawals.save(approved))
        ? { ...approved, version: approved.version + 1 }
        : await requireWithdrawal(this.deps, withdrawal.id);
    }
    return { withdrawal: await this.submit(withdrawal) };
  }

  /** Transmission à payment d'un retrait validé, pas encore transmis. */
  private async submit(withdrawal: Withdrawal): Promise<Withdrawal> {
    if (
      withdrawal.status !== 'awaiting_approval' ||
      withdrawal.approvedBy === null ||
      !withdrawal.beneficiaryPhone ||
      !withdrawal.beneficiaryName
    ) {
      return withdrawal;
    }
    const { payoutId } = await this.deps.executor.request({
      idempotencyKey: withdrawal.id,
      reference: withdrawalPayoutReference(withdrawal.id),
      amount: withdrawal.amount,
      beneficiary: {
        phone: withdrawal.beneficiaryPhone,
        operator: withdrawal.beneficiaryOperator,
        name: withdrawal.beneficiaryName,
      },
    });
    const next = markWithdrawalSubmitted(withdrawal, payoutId, this.deps.clock.now());
    if (next && (await this.deps.withdrawals.save(next))) return { ...next, version: next.version + 1 };
    // Issue déjà reçue entre-temps (événement plus rapide que la réponse) : l'état enregistré fait foi.
    return requireWithdrawal(this.deps, withdrawal.id);
  }
}

/**
 * Refus motivé d'un retrait pas encore validé : le montant retenu est rendu au portefeuille (écriture
 * `withdrawal_release`), dans la même transaction que le refus.
 */
export class RejectWithdrawalUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { withdrawalId: string; reason: string }): Promise<WithdrawalResult> {
    const staff = requireStaff(WITHDRAWAL_MFA_MAX_AGE_SECONDS);
    const reason = requireText('reason', input.reason, 500);
    const withdrawal = await requireWithdrawal(this.deps, input.withdrawalId);
    const release = transaction(this.deps, {
      kind: 'withdrawal_release',
      caller: WALLET,
      reference: `withdrawal-release:${withdrawal.id}`,
      holder: withdrawal.holder,
      amount: withdrawal.amount,
      description: 'Retrait refusé : montant rendu',
      actorId: staff.userId,
      entries: withdrawalReleaseEntries(withdrawal.holder, withdrawal.amount),
    });
    const next = rejectWithdrawal(withdrawal, {
      staffId: staff.userId,
      reason,
      settlementTransactionId: release.id,
      now: this.deps.clock.now(),
    });
    if (!next) throw WalletErrors.withdrawalInvalidTransition(withdrawal.status);
    const outcome = await this.deps.ledger.record({ transaction: release, updateWithdrawal: next });
    if (outcome.kind !== 'recorded') {
      const current = await requireWithdrawal(this.deps, withdrawal.id);
      throw WalletErrors.withdrawalInvalidTransition(current.status);
    }
    return {
      withdrawal: { ...next, version: next.version + 1 },
      wallet: await this.deps.ledger.prepaidSummary(withdrawal.holder),
    };
  }
}

export type WithdrawalSettlementOutcome = 'recorded' | 'duplicate' | 'ignored' | 'amount_mismatch';

/**
 * payment.payout.completed / failed d'un retrait (référence `wallet_withdrawal:<id>`) : terminé, le
 * montant en transit quitte les fonds des recharges ; en échec, il est rendu au portefeuille.
 * Écriture, retrait et inbox ensemble : un événement reçu deux fois n'a qu'un effet.
 */
export async function settleWithdrawalPayout(
  deps: WalletDeps,
  withdrawalId: string,
  input: {
    eventId: string;
    eventType: string;
    outcome: 'completed' | 'failed';
    paymentPayoutId: string;
    amount: number;
  },
): Promise<WithdrawalSettlementOutcome> {
  const withdrawal = await deps.withdrawals.findById(withdrawalId);
  if (!withdrawal) return 'ignored';
  if (['completed', 'failed', 'rejected'].includes(withdrawal.status)) return 'duplicate';
  if (input.amount !== withdrawal.amount) return 'amount_mismatch';
  const completed = input.outcome === 'completed';
  const settlement = transaction(deps, {
    kind: completed ? 'withdrawal_settlement' : 'withdrawal_release',
    caller: WALLET,
    reference: `${completed ? 'withdrawal-settlement' : 'withdrawal-release'}:${withdrawal.id}`,
    holder: withdrawal.holder,
    amount: withdrawal.amount,
    description: completed ? 'Retrait effectué' : 'Retrait en échec : montant rendu',
    entries: completed
      ? withdrawalSettlementEntries(withdrawal.amount)
      : withdrawalReleaseEntries(withdrawal.holder, withdrawal.amount),
  });
  const next = settleWithdrawal(withdrawal, {
    outcome: input.outcome,
    paymentPayoutId: input.paymentPayoutId,
    settlementTransactionId: settlement.id,
    now: deps.clock.now(),
  });
  // Jamais validé : payment ne peut pas l'avoir reçu de wallet.
  if (!next) return 'ignored';
  const outcome = await deps.ledger.record({
    transaction: settlement,
    updateWithdrawal: next,
    inbox: { eventId: input.eventId, consumer: `wallet.${input.eventType}` },
  });
  if (outcome.kind === 'recorded') return 'recorded';
  if (outcome.kind === 'already_processed' || outcome.kind === 'duplicate') return 'duplicate';
  // Retrait modifié en même temps (transmission notée) : l'événement sera réessayé.
  throw WalletErrors.concurrentUpdate();
}
