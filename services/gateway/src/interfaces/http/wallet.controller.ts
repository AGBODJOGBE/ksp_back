import { Body, Controller, Headers, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { type WalletApi, type WalletHolder } from '../../application/wallet/wallet.ports';
import { WALLET_API } from '../../tokens';
import { keyFrom, pageFrom, parseParam } from './params';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';
import { withdrawalStatus } from './wallet-schemas';

type Query = Record<string, unknown>;

/** Paramètres des routes du portefeuille (contrat OpenAPI). */
export const walletParams = {
  holderType: z.enum(['user', 'organization']),
  holderId: z.guid(),
  payoutStatus: z.enum(['pending_submission', 'submitted', 'completed', 'failed']).optional(),
  /** Compte du relevé (ADR-046) : fonds dus ou portefeuille prépayé ; absent : les deux. */
  statementAccount: z.enum(['collections', 'prepaid']).optional(),
  /** Statut d'une demande de crédit manuel (ADR-048) ; absent : toutes. */
  creditRequestStatus: z.enum(['pending_approval', 'approved', 'rejected']).optional(),
  creditRequestId: z.guid(),
  withdrawalId: z.guid(),
};

const holderFrom = (type: unknown, id: unknown, prefix = ''): WalletHolder => ({
  type: parseParam(walletParams.holderType, type, `${prefix}holderType`),
  id: parseParam(walletParams.holderId, id, `${prefix}holderId`),
});
const statusFrom = (query: Query) => parseParam(walletParams.payoutStatus, query['status'], 'status');
const accountFrom = (query: Query) => parseParam(walletParams.statementAccount, query['account'], 'account');

/**
 * Routes /api/v1/wallet/* (titulaire connecté : son compte, ou son organisation active) et
 * /api/v1/admin/wallet/* (finance), ADR-042 et ADR-046 ; wallet revérifie toujours les droits.
 */
@Controller()
export class WalletHttpController {
  constructor(@Inject(WALLET_API) private readonly wallet: WalletApi) {}

  @Route('getMyWallet')
  getMine() {
    return this.wallet.getMyWallet();
  }

  @Route('listMyWalletStatement')
  statement(@Query() query: Query) {
    const account = accountFrom(query);
    return this.wallet.listMyStatement(pageFrom(query), account);
  }

  @Route('createWalletTopUp')
  topUp(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const idempotencyKey = keyFrom(key);
    const { amount } = parseBody(requestBodies.createWalletTopUp, body);
    return this.wallet.createTopUp({ amount: amount.amount, idempotencyKey });
  }

  @Route('listMyWalletPayouts')
  payouts(@Query() query: Query) {
    const status = statusFrom(query);
    return this.wallet.listMyPayouts(pageFrom(query), status);
  }

  @Route('getHolderWallet')
  holder(@Param('type') type: unknown, @Param('id') id: unknown) {
    return this.wallet.getHolderWallet(holderFrom(type, id));
  }

  @Route('listHolderWalletStatement')
  holderStatement(@Param('type') type: unknown, @Param('id') id: unknown, @Query() query: Query) {
    const holder = holderFrom(type, id);
    const account = accountFrom(query);
    return this.wallet.listHolderStatement(holder, pageFrom(query), account);
  }

  @Route('creditPrepaidWallet')
  credit(
    @Param('type') type: unknown,
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const holder = holderFrom(type, id);
    const idempotencyKey = keyFrom(key);
    const input = parseBody(requestBodies.creditPrepaidWallet, body);
    return this.wallet.creditPrepaidWallet(holder, {
      kind: input.kind,
      amount: input.amount.amount,
      reason: input.reason,
      paymentId: input.paymentId,
      receiptReference: input.receiptReference,
      forObject: input.forObject,
      idempotencyKey,
    });
  }

  @Route('listManualCreditRequests')
  creditRequests(@Query() query: Query) {
    const status = parseParam(walletParams.creditRequestStatus, query['status'], 'status');
    return this.wallet.listManualCreditRequests(pageFrom(query), status);
  }

  @Route('approveManualCredit')
  approveCredit(@Param('id') id: unknown) {
    return this.wallet.approveManualCredit(parseParam(walletParams.creditRequestId, id, 'id'));
  }

  @Route('listWalletPayouts')
  allPayouts(@Query() query: Query) {
    const status = statusFrom(query);
    const holder =
      query['holderType'] !== undefined || query['holderId'] !== undefined
        ? holderFrom(query['holderType'], query['holderId'])
        : undefined;
    return this.wallet.listWalletPayouts(pageFrom(query), { status, holder });
  }

  @Route('getWalletLedgerOverview')
  overview() {
    return this.wallet.getLedgerOverview();
  }

  // Retraits vers Mobile Money (R-WL-04) : demande du titulaire, traitement puis validation par
  // deux personnes de la finance (revérifié par wallet).
  @Route('requestWithdrawal')
  requestWithdrawal(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const idempotencyKey = keyFrom(key);
    const input = parseBody(requestBodies.requestWithdrawal, body);
    return this.wallet.requestWithdrawal({
      amount: input.amount.amount,
      beneficiary: input.beneficiary,
      idempotencyKey,
    });
  }

  @Route('listMyWithdrawals')
  myWithdrawals(@Query() query: Query) {
    const status = parseParam(withdrawalStatus, query['status'], 'status');
    return this.wallet.listMyWithdrawals(pageFrom(query), status);
  }

  @Route('rejectManualCredit')
  rejectCredit(@Param('id') id: unknown, @Body() body: unknown) {
    const requestId = parseParam(walletParams.creditRequestId, id, 'id');
    return this.wallet.rejectManualCredit(
      requestId,
      parseBody(requestBodies.rejectManualCredit, body).reason,
    );
  }

  @Route('listWithdrawals')
  withdrawals(@Query() query: Query) {
    const status = parseParam(withdrawalStatus, query['status'], 'status');
    const holder =
      query['holderType'] !== undefined || query['holderId'] !== undefined
        ? holderFrom(query['holderType'], query['holderId'])
        : undefined;
    return this.wallet.listWithdrawals(pageFrom(query), { status, holder });
  }

  @Route('processWithdrawal')
  processWithdrawal(@Param('id') id: unknown, @Body() body: unknown) {
    const withdrawalId = parseParam(walletParams.withdrawalId, id, 'id');
    return this.wallet.processWithdrawal(withdrawalId, parseBody(requestBodies.processWithdrawal, body).note);
  }

  @Route('approveWithdrawal')
  approveWithdrawal(@Param('id') id: unknown) {
    return this.wallet.approveWithdrawal(parseParam(walletParams.withdrawalId, id, 'id'));
  }

  @Route('rejectWithdrawal')
  rejectWithdrawal(@Param('id') id: unknown, @Body() body: unknown) {
    const withdrawalId = parseParam(walletParams.withdrawalId, id, 'id');
    return this.wallet.rejectWithdrawal(withdrawalId, parseBody(requestBodies.rejectWithdrawal, body).reason);
  }
}
