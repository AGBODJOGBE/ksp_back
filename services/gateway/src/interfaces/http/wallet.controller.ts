import { Controller, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { type WalletApi, type WalletHolder } from '../../application/wallet/wallet.ports';
import { WALLET_API } from '../../tokens';
import { pageFrom } from './cleaning.controller';
import { parseParam } from './cleaning-schemas';
import { Route } from './route.decorator';

type Query = Record<string, unknown>;

/** Paramètres des routes du portefeuille (contrat OpenAPI). */
export const walletParams = {
  holderType: z.enum(['user', 'organization']),
  holderId: z.guid(),
  payoutStatus: z.enum(['pending_submission', 'submitted', 'completed', 'failed']).optional(),
};

const holderFrom = (type: unknown, id: unknown, prefix = ''): WalletHolder => ({
  type: parseParam(walletParams.holderType, type, `${prefix}holderType`),
  id: parseParam(walletParams.holderId, id, `${prefix}holderId`),
});
const statusFrom = (query: Query) => parseParam(walletParams.payoutStatus, query['status'], 'status');

/**
 * Routes /api/v1/wallet/* (titulaire connecté : son compte, ou son organisation active) et
 * /api/v1/admin/wallet/* (finance), ADR-042. Lecture seule ; wallet revérifie toujours les droits.
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
    return this.wallet.listMyStatement(pageFrom(query));
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
    return this.wallet.listHolderStatement(holder, pageFrom(query));
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
}
