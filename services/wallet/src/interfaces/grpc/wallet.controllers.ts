import { AllowedCallers } from '@ksp/platform';
import { commonV1, walletV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import {
  type ManualCreditRequest,
  type PageResult,
  type PrepaidSummary,
  type StatementLine,
  type WalletSummary,
} from '../../application/ports';
import { parsePage } from '../../application/shared';
import { WALLET_USE_CASES, type WalletUseCases } from '../../application/use-cases';
import { type LedgerTransaction } from '../../domain/ledger';
import { type WalletPayout } from '../../domain/wallet-payout';

const iso = (value: Date | null) => (value ? value.toISOString() : '');
const xof = (amount: number) => ({ amount, currency: 'XOF' });
/** Montant facultatif : absent (null) devient un montant nul, comme le veut le contrat. */
const optionalXof = (amount: number | null) => (amount === null ? undefined : xof(amount));

export function presentPrepaid(summary: PrepaidSummary): walletV1.PrepaidWallet {
  return {
    holder: { ...summary.holder },
    balance: xof(summary.balance),
    lastEntryAt: iso(summary.lastEntryAt),
  };
}

export function presentWallet(summary: WalletSummary): walletV1.Wallet {
  return {
    holder: { ...summary.holder },
    balance: xof(summary.balance),
    payoutsInProgress: xof(summary.payoutsInProgress),
    totalCollected: xof(summary.totalCollected),
    totalPaidOut: xof(summary.totalPaidOut),
    lastEntryAt: iso(summary.lastEntryAt),
    prepaid: presentPrepaid(summary.prepaid),
  };
}

/** Objet payé par un débit (et son remboursement), avec le service appelant. */
function presentObject(transaction: LedgerTransaction): walletV1.ObjectReference | undefined {
  const object = transaction.object;
  return object
    ? { service: transaction.caller, objectType: object.type, objectId: object.id, part: object.part ?? '' }
    : undefined;
}

/** Demande de crédit manuel soumise à double validation (ADR-048). */
export function presentCreditRequest(request: ManualCreditRequest): walletV1.ManualCreditRequest {
  return {
    id: request.id,
    holder: { ...request.holder },
    kind: request.kind,
    amount: { amount: request.amount, currency: 'XOF' },
    reason: request.reason,
    paymentId: request.paymentId ?? '',
    status: request.status,
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt.toISOString(),
    approvedBy: request.approvedBy ?? '',
    approvedAt: request.approvedAt?.toISOString() ?? '',
    transactionId: request.transactionId ?? '',
  };
}

export function presentTransaction(transaction: LedgerTransaction): walletV1.LedgerTransaction {
  return {
    id: transaction.id,
    kind: transaction.kind,
    reference: transaction.reference,
    holder: { ...transaction.holder },
    amount: xof(transaction.amount),
    grossAmount: optionalXof(transaction.grossAmount),
    commission: optionalXof(transaction.commission),
    commissionRateBps: transaction.commissionRateBps ?? 0,
    description: transaction.description,
    reversesTransactionId: transaction.reversesTransactionId ?? '',
    createdAt: iso(transaction.createdAt),
    entries: transaction.entries.map((line) => ({ ...line, amount: xof(line.amount) })),
    object: presentObject(transaction),
  };
}

/** Relevé : `payout_hold` est présenté comme `payout` (point de vue du titulaire). */
export function presentStatement(page: PageResult<StatementLine>): walletV1.StatementPage {
  return {
    lines: page.items.map((line) => {
      const t = line.transaction;
      return {
        transactionId: t.id,
        kind: t.kind === 'payout_hold' ? 'payout' : t.kind,
        direction: line.direction,
        amount: xof(line.amount),
        balanceAfter: xof(line.balanceAfter),
        reference: t.reference,
        description: t.description,
        grossAmount: optionalXof(t.grossAmount),
        commission: optionalXof(t.commission),
        commissionRateBps: t.commissionRateBps ?? 0,
        payoutId: t.payoutId ?? '',
        payoutStatus: line.payoutStatus ?? '',
        reversesTransactionId: t.reversesTransactionId ?? '',
        createdAt: iso(t.createdAt),
        account: line.account,
        object: presentObject(t),
      };
    }),
    nextCursor: page.nextCursor ?? '',
  };
}

/** Reversement : jamais le numéro complet ni le nom, seulement le numéro masqué et l'opérateur. */
export function presentPayout(payout: WalletPayout): walletV1.WalletPayout {
  return {
    id: payout.id,
    holder: { ...payout.holder },
    amount: xof(payout.amount),
    status: payout.status,
    paymentPayoutId: payout.paymentPayoutId ?? '',
    beneficiaryOperator: payout.beneficiaryOperator,
    beneficiaryPhoneMasked: payout.beneficiaryPhoneMasked,
    holdTransactionId: payout.holdTransactionId,
    settlementTransactionId: payout.settlementTransactionId ?? '',
    createdAt: iso(payout.createdAt),
    updatedAt: iso(payout.updatedAt),
    completedAt: iso(payout.completedAt),
    failedAt: iso(payout.failedAt),
  };
}

const payoutPage = (page: PageResult<WalletPayout>) => ({
  payouts: page.items.map(presentPayout),
  nextCursor: page.nextCursor ?? '',
});

/** Opérations des services métier (recovery). Droits vérifiés par les cas d'usage. */
/**
 * ksp.common.v1.ObligationService, interrogé par identity avant la suppression d'un compte
 * (UC-ID-11, ADR-036, ADR-048). Le contrôle de l'appelant est fait par le cas d'usage.
 */
@Controller()
@commonV1.ObligationServiceControllerMethods()
export class ObligationGrpcController implements commonV1.ObligationServiceController {
  constructor(@Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases) {}

  async hasPendingObligations(
    request: commonV1.HasPendingObligationsRequest,
  ): Promise<commonV1.HasPendingObligationsResponse> {
    const obligations = await this.useCases.hasPendingObligations.execute({ userId: request.userId });
    return { hasPending: obligations.length > 0, obligations };
  }
}

@Controller()
@walletV1.WalletServiceControllerMethods()
export class WalletGrpcController implements walletV1.WalletServiceController {
  constructor(@Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases) {}

  async recordCollection(
    request: walletV1.RecordCollectionRequest,
  ): Promise<walletV1.RecordCollectionResponse> {
    const result = await this.useCases.recordCollection.execute({
      holder: request.holder,
      grossAmount: request.grossAmount,
      commissionRateBps: request.commissionRateBps,
      reference: request.reference,
      description: request.description,
    });
    return {
      transaction: presentTransaction(result.transaction),
      wallet: presentWallet(result.wallet),
      created: result.created,
    };
  }

  async requestPayout(request: walletV1.RequestPayoutRequest): Promise<walletV1.RequestPayoutResponse> {
    const result = await this.useCases.requestPayout.execute({
      idempotencyKey: request.idempotencyKey,
      holder: request.holder,
      amount: request.amount,
      beneficiary: request.beneficiary,
    });
    return {
      payout: presentPayout(result.payout),
      wallet: presentWallet(result.wallet),
      created: result.created,
    };
  }

  async reverseTransaction(
    request: walletV1.ReverseTransactionRequest,
  ): Promise<walletV1.ReverseTransactionResponse> {
    const result = await this.useCases.reverseTransaction.execute({
      transactionId: request.transactionId,
      reason: request.reason,
      reference: request.reference,
    });
    return {
      transaction: presentTransaction(result.transaction),
      wallet: presentWallet(result.wallet),
      created: result.created,
    };
  }

  async getBalance(request: walletV1.GetBalanceRequest): Promise<walletV1.GetBalanceResponse> {
    return { wallet: presentWallet(await this.useCases.getBalance.execute(request.holder)) };
  }

  async listStatement(request: walletV1.ListStatementRequest): Promise<walletV1.ListStatementResponse> {
    const page = await this.useCases.listStatement.execute(request.holder, parsePage(request.page));
    return { statement: presentStatement(page) };
  }

  async debit(request: walletV1.DebitRequest): Promise<walletV1.DebitResponse> {
    const result = await this.useCases.debitPrepaid.execute({
      idempotencyKey: request.idempotencyKey,
      holder: request.holder,
      amount: request.amount,
      object: request.object,
      description: request.description,
    });
    return {
      transaction: presentTransaction(result.transaction),
      wallet: presentPrepaid(result.wallet),
      created: result.created,
    };
  }

  async refund(request: walletV1.RefundRequest): Promise<walletV1.RefundResponse> {
    const result = await this.useCases.refundDebit.execute({
      transactionId: request.transactionId,
      reason: request.reason,
    });
    return {
      transaction: presentTransaction(result.transaction),
      wallet: presentPrepaid(result.wallet),
      created: result.created,
    };
  }

  async getPrepaidBalance(
    request: walletV1.GetPrepaidBalanceRequest,
  ): Promise<walletV1.GetPrepaidBalanceResponse> {
    return { wallet: presentPrepaid(await this.useCases.getPrepaidBalance.execute(request.holder)) };
  }
}

/** Espace du titulaire connecté (gateway). */
@Controller()
@AllowedCallers('gateway')
@walletV1.WalletAccountServiceControllerMethods()
export class WalletAccountGrpcController implements walletV1.WalletAccountServiceController {
  constructor(@Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases) {}

  async getMyWallet(): Promise<walletV1.GetMyWalletResponse> {
    const { wallet, topUpLimits } = await this.useCases.getMyWallet.execute();
    return {
      wallet: presentWallet(wallet),
      topUpLimits: { min: xof(topUpLimits.min), max: xof(topUpLimits.max) },
    };
  }

  async listMyStatement(request: walletV1.ListMyStatementRequest): Promise<walletV1.ListMyStatementResponse> {
    const page = await this.useCases.listMyStatement.execute({
      page: parsePage(request.page),
      account: request.account,
    });
    return { statement: presentStatement(page) };
  }

  async createTopUp(request: walletV1.CreateTopUpRequest): Promise<walletV1.CreateTopUpResponse> {
    const { topUp, created } = await this.useCases.createTopUp.execute({
      idempotencyKey: request.idempotencyKey,
      amount: request.amount,
    });
    return {
      topUp: {
        paymentId: topUp.paymentId,
        holder: { ...topUp.holder },
        amount: xof(topUp.amount),
        status: topUp.status,
        checkoutUrl: topUp.checkoutUrl ?? '',
        expiresAt: iso(topUp.expiresAt),
      },
      created,
    };
  }

  async listMyPayouts(request: walletV1.ListMyPayoutsRequest): Promise<walletV1.ListMyPayoutsResponse> {
    return payoutPage(
      await this.useCases.listMyPayouts.execute({ page: parsePage(request.page), status: request.status }),
    );
  }
}

/** Back-office (finance). */
@Controller()
@AllowedCallers('gateway')
@walletV1.WalletAdminServiceControllerMethods()
export class WalletAdminGrpcController implements walletV1.WalletAdminServiceController {
  constructor(@Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases) {}

  async getHolderWallet(request: walletV1.GetHolderWalletRequest): Promise<walletV1.GetHolderWalletResponse> {
    return { wallet: presentWallet(await this.useCases.getHolderWallet.execute(request.holder)) };
  }

  async listHolderStatement(
    request: walletV1.ListHolderStatementRequest,
  ): Promise<walletV1.ListHolderStatementResponse> {
    const page = await this.useCases.listHolderStatement.execute({
      holder: request.holder,
      page: parsePage(request.page),
      account: request.account,
    });
    return { statement: presentStatement(page) };
  }

  async listWalletPayouts(
    request: walletV1.ListWalletPayoutsRequest,
  ): Promise<walletV1.ListWalletPayoutsResponse> {
    return payoutPage(
      await this.useCases.listWalletPayouts.execute({
        page: parsePage(request.page),
        status: request.status,
        holder: request.holder,
      }),
    );
  }

  async getLedgerOverview(): Promise<walletV1.GetLedgerOverviewResponse> {
    const overview = await this.useCases.getLedgerOverview.execute();
    return {
      internalAccounts: overview.internal.map((entry) => ({
        account: entry.account,
        balance: xof(entry.balance),
      })),
      owedToHolders: xof(overview.owedToHolders),
      holdersCount: overview.holdersCount,
      owedToCustomers: xof(overview.owedToCustomers),
      customersCount: overview.customersCount,
    };
  }

  async creditPrepaidWallet(
    request: walletV1.CreditPrepaidWalletRequest,
  ): Promise<walletV1.CreditPrepaidWalletResponse> {
    const result = await this.useCases.creditPrepaidWallet.execute({
      idempotencyKey: request.idempotencyKey,
      holder: request.holder,
      kind: request.kind,
      amount: request.amount,
      reason: request.reason,
      paymentId: request.paymentId,
    });
    return {
      ...(result.transaction ? { transaction: presentTransaction(result.transaction) } : {}),
      wallet: presentPrepaid(result.wallet),
      created: result.created,
      ...(result.pendingRequest ? { pendingRequest: presentCreditRequest(result.pendingRequest) } : {}),
    };
  }

  async listManualCreditRequests(
    request: walletV1.ListManualCreditRequestsRequest,
  ): Promise<walletV1.ListManualCreditRequestsResponse> {
    const page = await this.useCases.listManualCreditRequests.execute({
      page: parsePage(request.page),
      status: request.status,
    });
    return { requests: page.items.map(presentCreditRequest), nextCursor: page.nextCursor ?? '' };
  }

  async approveManualCredit(
    request: walletV1.ApproveManualCreditRequest,
  ): Promise<walletV1.ApproveManualCreditResponse> {
    const result = await this.useCases.approveManualCredit.execute(request.requestId);
    return {
      transaction: presentTransaction(result.transaction),
      wallet: presentPrepaid(result.wallet),
      request: presentCreditRequest(result.request),
      created: result.created,
    };
  }
}
