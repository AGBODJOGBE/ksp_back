import { HasPendingObligationsUseCase } from './obligations.use-cases';
import { type WalletDeps } from './ports';
import {
  CreateTopUpUseCase,
  CreditPrepaidWalletUseCase,
  CreditTopUpUseCase,
  DebitPrepaidUseCase,
  GetPrepaidBalanceUseCase,
  RefundDebitUseCase,
  RefundFromEventUseCase,
} from './prepaid.use-cases';
import {
  GetBalanceUseCase,
  GetHolderWalletUseCase,
  GetLedgerOverviewUseCase,
  GetMyWalletUseCase,
  ListHolderStatementUseCase,
  ListMyPayoutsUseCase,
  ListMyStatementUseCase,
  ListStatementUseCase,
  ListWalletPayoutsUseCase,
  RecordCollectionUseCase,
  RequestPayoutUseCase,
  ReverseTransactionUseCase,
  SettlePayoutUseCase,
  SubmitPendingPayoutsUseCase,
} from './wallet.use-cases';

/** Cas d'usage du service (une classe chacun), reliés aux mêmes dépendances. */
export function createUseCases(deps: WalletDeps) {
  return {
    recordCollection: new RecordCollectionUseCase(deps),
    requestPayout: new RequestPayoutUseCase(deps),
    submitPendingPayouts: new SubmitPendingPayoutsUseCase(deps),
    reverseTransaction: new ReverseTransactionUseCase(deps),
    getBalance: new GetBalanceUseCase(deps),
    listStatement: new ListStatementUseCase(deps),
    getMyWallet: new GetMyWalletUseCase(deps),
    listMyStatement: new ListMyStatementUseCase(deps),
    listMyPayouts: new ListMyPayoutsUseCase(deps),
    getHolderWallet: new GetHolderWalletUseCase(deps),
    listHolderStatement: new ListHolderStatementUseCase(deps),
    listWalletPayouts: new ListWalletPayoutsUseCase(deps),
    getLedgerOverview: new GetLedgerOverviewUseCase(deps),
    settlePayout: new SettlePayoutUseCase(deps),
    debitPrepaid: new DebitPrepaidUseCase(deps),
    refundDebit: new RefundDebitUseCase(deps),
    refundFromEvent: new RefundFromEventUseCase(deps),
    getPrepaidBalance: new GetPrepaidBalanceUseCase(deps),
    createTopUp: new CreateTopUpUseCase(deps),
    creditTopUp: new CreditTopUpUseCase(deps),
    creditPrepaidWallet: new CreditPrepaidWalletUseCase(deps),
    hasPendingObligations: new HasPendingObligationsUseCase(deps),
  };
}

export type WalletUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection des cas d'usage (racine de composition). */
export const WALLET_USE_CASES = Symbol('WALLET_USE_CASES');
