import { type Metadata } from '@grpc/grpc-js';
import { type moneyV1, type walletV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type Json, type Page } from '../../application/common/api.ports';
import { type WalletApi, type WalletHolder, type WalletObject } from '../../application/wallet/wallet.ports';
import { toUpstreamError } from './upstream-error';

export interface WalletClients {
  account: walletV1.WalletAccountServiceClient;
  admin: walletV1.WalletAdminServiceClient;
}

const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de wallet inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);
const xof = (value: moneyV1.Money | undefined) => ({
  amount: Number(value?.amount ?? 0),
  currency: value?.currency || 'XOF',
});
const page = (value: Page): walletV1.Page => ({ limit: value.limit ?? 0, cursor: value.cursor ?? '' });

/** Portefeuille prépayé (ADR-046) : solde dépensable, jamais négatif. */
/** Demande de crédit manuel soumise à double validation (ADR-048). */
function presentCreditRequest(value: walletV1.ManualCreditRequest) {
  return {
    id: value.id,
    holder: { type: value.holder?.type ?? '', id: value.holder?.id ?? '' },
    kind: value.kind,
    amount: xof(value.amount),
    reason: value.reason,
    paymentId: value.paymentId || null,
    status: value.status,
    requestedBy: value.requestedBy,
    requestedAt: value.requestedAt,
    approvedBy: value.approvedBy || null,
    approvedAt: value.approvedAt || null,
    transactionId: value.transactionId || null,
    // v2 (R-WL-02, R-PE-04) : reçu, objet à régler, rejet ; absents d'une demande d'avant.
    ...(value.receiptReference !== undefined ? { receiptReference: value.receiptReference || null } : {}),
    ...(value.forObject ? { forObject: presentObject(value.forObject) } : {}),
    ...(value.rejectedAt !== undefined
      ? {
          rejectedBy: value.rejectedBy || null,
          rejectedAt: value.rejectedAt || null,
          rejectionReason: value.rejectionReason || null,
        }
      : {}),
  };
}

/** Objet d'un service réglé par le portefeuille (v2, R-WL-05). */
function presentObject(value: walletV1.ObjectReference) {
  return {
    service: value.service,
    objectType: value.objectType,
    objectId: value.objectId,
    part: orNull(value.part),
  };
}

/**
 * Retrait vers Mobile Money (R-WL-04) : numéro masqué seulement. La note de traitement ne sort
 * qu'au back-office.
 */
export function presentWithdrawal(value: walletV1.Withdrawal | undefined, backoffice: boolean) {
  if (!value?.holder) throw malformed('retrait');
  return {
    id: value.id,
    holder: { type: value.holder.type, id: value.holder.id },
    amount: xof(value.amount),
    status: value.status,
    beneficiaryOperator: value.beneficiaryOperator,
    beneficiaryPhoneMasked: value.beneficiaryPhoneMasked,
    requestedBy: value.requestedBy,
    requestedAt: value.requestedAt,
    processedBy: orNull(value.processedBy),
    processedAt: orNull(value.processedAt),
    ...(backoffice ? { processingNote: orNull(value.processingNote) } : {}),
    approvedBy: orNull(value.approvedBy),
    approvedAt: orNull(value.approvedAt),
    rejectedAt: orNull(value.rejectedAt),
    rejectionReason: orNull(value.rejectionReason),
    paymentPayoutId: orNull(value.paymentPayoutId),
    completedAt: orNull(value.completedAt),
    failedAt: orNull(value.failedAt),
  };
}

const withdrawals = (
  res: { withdrawals: walletV1.Withdrawal[]; nextCursor: string },
  backoffice: boolean,
) => ({
  data: res.withdrawals.map((withdrawal) => presentWithdrawal(withdrawal, backoffice)),
  nextCursor: res.nextCursor || null,
});

export function presentPrepaid(value: walletV1.PrepaidWallet | undefined) {
  if (!value?.holder) throw malformed('portefeuille prépayé');
  return {
    holder: { type: value.holder.type, id: value.holder.id },
    balance: xof(value.balance),
    lastEntryAt: orNull(value.lastEntryAt),
    ...(value.withdrawalsInProgress ? { withdrawalsInProgress: xof(value.withdrawalsInProgress) } : {}),
  };
}

export function presentWallet(value: walletV1.Wallet | undefined) {
  if (!value?.holder) throw malformed('portefeuille');
  return {
    holder: { type: value.holder.type, id: value.holder.id },
    balance: xof(value.balance),
    payoutsInProgress: xof(value.payoutsInProgress),
    totalCollected: xof(value.totalCollected),
    totalPaidOut: xof(value.totalPaidOut),
    lastEntryAt: orNull(value.lastEntryAt),
    prepaid: presentPrepaid(value.prepaid),
  };
}

/**
 * Relevé : encaissement avec brut, commission et taux ; reversement avec son statut ; portefeuille
 * prépayé (ADR-046) avec l'objet payé (mission, facture).
 */
export function presentStatement(value: walletV1.StatementPage | undefined) {
  if (!value) throw malformed('relevé');
  return {
    data: value.lines.map((line) => {
      const collection = line.kind === 'collection' || line.kind === 'reversal';
      return {
        transactionId: line.transactionId,
        kind: line.kind,
        direction: line.direction,
        amount: xof(line.amount),
        balanceAfter: xof(line.balanceAfter),
        reference: line.reference,
        description: line.description,
        grossAmount: collection ? xof(line.grossAmount) : null,
        commission: collection ? xof(line.commission) : null,
        commissionRateBps: collection ? line.commissionRateBps : null,
        payoutId: orNull(line.payoutId),
        payoutStatus: orNull(line.payoutStatus),
        reversesTransactionId: orNull(line.reversesTransactionId),
        createdAt: line.createdAt,
        account: line.account || 'collections',
        object: line.object
          ? {
              service: line.object.service,
              objectType: line.object.objectType,
              objectId: line.object.objectId,
              part: orNull(line.object.part),
            }
          : null,
      };
    }),
    nextCursor: value.nextCursor || null,
  };
}

/** Reversement : numéro masqué seulement (wallet ne garde pas le numéro complet). */
export function presentWalletPayout(value: walletV1.WalletPayout) {
  if (!value.holder) throw malformed('reversement');
  return {
    id: value.id,
    holder: { type: value.holder.type, id: value.holder.id },
    amount: xof(value.amount),
    status: value.status,
    paymentPayoutId: orNull(value.paymentPayoutId),
    beneficiaryOperator: value.beneficiaryOperator,
    beneficiaryPhoneMasked: value.beneficiaryPhoneMasked,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: orNull(value.completedAt),
    failedAt: orNull(value.failedAt),
  };
}

const payouts = (res: { payouts: walletV1.WalletPayout[]; nextCursor: string }) => ({
  data: res.payouts.map(presentWalletPayout),
  nextCursor: res.nextCursor || null,
});

/** Client gRPC de wallet : appels rejouables (délai, coupe-circuit, jeton de service), écritures idempotentes par clé. */
export class WalletGrpcAdapter implements WalletApi {
  private readonly logger = new Logger('WalletGrpc');

  constructor(
    private readonly clients: WalletClients,
    private readonly caller: GrpcCaller,
  ) {}

  async getMyWallet(): Promise<Json> {
    const res = await this.read('getMyWallet', (m) => this.clients.account.getMyWallet({}, m));
    return {
      ...presentWallet(res.wallet),
      topUpLimits: { min: xof(res.topUpLimits?.min), max: xof(res.topUpLimits?.max) },
    };
  }

  async listMyStatement(value: Page, account: string | undefined): Promise<Json> {
    const res = await this.read('listMyStatement', (m) =>
      this.clients.account.listMyStatement({ page: page(value), account: account ?? '' }, m),
    );
    return presentStatement(res.statement);
  }

  /** Recharge : idempotente par clé chez wallet et payment, donc rejouable après une panne. */
  async createTopUp(input: { amount: number; idempotencyKey: string }): Promise<Json> {
    const res = await this.read('createTopUp', (m) =>
      this.clients.account.createTopUp(
        { idempotencyKey: input.idempotencyKey, amount: { amount: input.amount, currency: 'XOF' } },
        m,
      ),
    );
    const topUp = res.topUp;
    if (!topUp?.holder) throw malformed('recharge');
    return {
      paymentId: topUp.paymentId,
      holder: { type: topUp.holder.type, id: topUp.holder.id },
      amount: xof(topUp.amount),
      status: topUp.status,
      checkoutUrl: orNull(topUp.checkoutUrl),
      expiresAt: orNull(topUp.expiresAt),
    };
  }

  async listMyPayouts(value: Page, status: string | undefined): Promise<Json> {
    return payouts(
      await this.read('listMyPayouts', (m) =>
        this.clients.account.listMyPayouts({ page: page(value), status: status ?? '' }, m),
      ),
    );
  }

  async getHolderWallet(holder: WalletHolder): Promise<Json> {
    const res = await this.read('getHolderWallet', (m) => this.clients.admin.getHolderWallet({ holder }, m));
    return presentWallet(res.wallet);
  }

  async listHolderStatement(holder: WalletHolder, value: Page, account: string | undefined): Promise<Json> {
    const res = await this.read('listHolderStatement', (m) =>
      this.clients.admin.listHolderStatement({ holder, page: page(value), account: account ?? '' }, m),
    );
    return presentStatement(res.statement);
  }

  /** Crédit manuel : idempotent par clé (ou par paiement) chez wallet, donc rejouable. */
  async creditPrepaidWallet(
    holder: WalletHolder,
    input: {
      kind: string;
      amount: number;
      reason: string;
      paymentId?: string | undefined;
      receiptReference?: string | undefined;
      forObject?: WalletObject | undefined;
      idempotencyKey: string;
    },
  ): Promise<Json> {
    const res = await this.read('creditPrepaidWallet', (m) =>
      this.clients.admin.creditPrepaidWallet(
        {
          idempotencyKey: input.idempotencyKey,
          holder,
          kind: input.kind,
          amount: { amount: input.amount, currency: 'XOF' },
          reason: input.reason,
          paymentId: input.paymentId ?? '',
          ...(input.receiptReference ? { receiptReference: input.receiptReference } : {}),
          ...(input.forObject
            ? {
                forObject: {
                  service: input.forObject.service ?? '',
                  objectType: input.forObject.objectType,
                  objectId: input.forObject.objectId,
                  part: input.forObject.part ?? '',
                },
              }
            : {}),
        },
        m,
      ),
    );
    // Au-delà du seuil de double validation : demande en attente, rien n'est crédité (ADR-048).
    if (res.pendingRequest) {
      return {
        pendingRequest: presentCreditRequest(res.pendingRequest),
        wallet: presentPrepaid(res.wallet),
        created: res.created,
      };
    }
    if (!res.transaction) throw malformed('crédit');
    return {
      transactionId: res.transaction.id,
      kind: res.transaction.kind,
      amount: xof(res.transaction.amount),
      description: res.transaction.description,
      createdAt: res.transaction.createdAt,
      wallet: presentPrepaid(res.wallet),
      created: res.created,
    };
  }

  async listManualCreditRequests(value: Page, status: string | undefined): Promise<Json> {
    const res = await this.read('listManualCreditRequests', (m) =>
      this.clients.admin.listManualCreditRequests({ page: page(value), status: status ?? '' }, m),
    );
    return { items: res.requests.map(presentCreditRequest), nextCursor: res.nextCursor || null };
  }

  async approveManualCredit(requestId: string): Promise<Json> {
    const res = await this.read('approveManualCredit', (m) =>
      this.clients.admin.approveManualCredit({ requestId }, m),
    );
    if (!res.transaction || !res.request) throw malformed('validation de crédit');
    return {
      transactionId: res.transaction.id,
      kind: res.transaction.kind,
      amount: xof(res.transaction.amount),
      description: res.transaction.description,
      createdAt: res.transaction.createdAt,
      wallet: presentPrepaid(res.wallet),
      request: presentCreditRequest(res.request),
      created: res.created,
    };
  }

  async listWalletPayouts(
    value: Page,
    filters: { status?: string | undefined; holder?: WalletHolder | undefined },
  ): Promise<Json> {
    return payouts(
      await this.read('listWalletPayouts', (m) =>
        this.clients.admin.listWalletPayouts(
          {
            page: page(value),
            status: filters.status ?? '',
            ...(filters.holder ? { holder: filters.holder } : {}),
          },
          m,
        ),
      ),
    );
  }

  async getLedgerOverview(): Promise<Json> {
    const res = await this.read('getLedgerOverview', (m) => this.clients.admin.getLedgerOverview({}, m));
    return {
      internalAccounts: res.internalAccounts.map((account) => ({
        account: account.account,
        balance: xof(account.balance),
      })),
      owedToHolders: xof(res.owedToHolders),
      holdersCount: res.holdersCount,
      owedToCustomers: xof(res.owedToCustomers),
      customersCount: res.customersCount,
    };
  }

  /** Retrait : idempotent par clé chez wallet, donc rejouable après une panne. */
  async requestWithdrawal(input: {
    amount: number;
    beneficiary: { phone: string; operator: string; name: string };
    idempotencyKey: string;
  }): Promise<Json> {
    const res = await this.read('requestWithdrawal', (m) =>
      this.clients.account.requestWithdrawal(
        {
          idempotencyKey: input.idempotencyKey,
          amount: { amount: input.amount, currency: 'XOF' },
          beneficiary: {
            phone: input.beneficiary.phone,
            operator: input.beneficiary.operator,
            name: input.beneficiary.name,
          },
        },
        m,
      ),
    );
    return {
      withdrawal: presentWithdrawal(res.withdrawal, false),
      wallet: presentPrepaid(res.wallet),
      created: res.created,
    };
  }

  async listMyWithdrawals(value: Page, status: string | undefined): Promise<Json> {
    const res = await this.read('listMyWithdrawals', (m) =>
      this.clients.account.listMyWithdrawals({ page: page(value), status: status ?? '' }, m),
    );
    return withdrawals(res, false);
  }

  async rejectManualCredit(requestId: string, reason: string): Promise<Json> {
    const res = await this.write('rejectManualCredit', (m) =>
      this.clients.admin.rejectManualCredit({ requestId, reason }, m),
    );
    if (!res.request) throw malformed('rejet de crédit');
    return presentCreditRequest(res.request);
  }

  async listWithdrawals(
    value: Page,
    filters: { status?: string | undefined; holder?: WalletHolder | undefined },
  ): Promise<Json> {
    const res = await this.read('listWithdrawals', (m) =>
      this.clients.admin.listWithdrawals(
        {
          page: page(value),
          status: filters.status ?? '',
          ...(filters.holder ? { holder: filters.holder } : {}),
        },
        m,
      ),
    );
    return withdrawals(res, true);
  }

  async processWithdrawal(withdrawalId: string, note: string): Promise<Json> {
    const res = await this.write('processWithdrawal', (m) =>
      this.clients.admin.processWithdrawal({ withdrawalId, note }, m),
    );
    return presentWithdrawal(res.withdrawal, true);
  }

  async approveWithdrawal(withdrawalId: string): Promise<Json> {
    const res = await this.write('approveWithdrawal', (m) =>
      this.clients.admin.approveWithdrawal({ withdrawalId }, m),
    );
    return presentWithdrawal(res.withdrawal, true);
  }

  async rejectWithdrawal(withdrawalId: string, reason: string): Promise<Json> {
    const res = await this.write('rejectWithdrawal', (m) =>
      this.clients.admin.rejectWithdrawal({ withdrawalId, reason }, m),
    );
    return presentWithdrawal(res.withdrawal, true);
  }

  private read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, { idempotent: true });
  }

  /** Décision de la finance (traiter, valider, refuser) : jamais rejouée automatiquement. */
  private write<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, {});
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('wallet', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`wallet.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
