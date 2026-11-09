import { type Json, type Page } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur le service wallet (ADR-042, ADR-046), indépendante de gRPC : lectures,
 * recharge du portefeuille prépayé et crédit manuel de la finance ; les débits viennent des
 * services métier.
 */
export interface WalletHolder {
  type: 'user' | 'organization';
  id: string;
}

/** Un appel par méthode de ksp.wallet.v1 exposée en REST. */
export interface WalletApi {
  getMyWallet(): Promise<Json>;
  /** `account` : `collections` ou `prepaid`, absent pour les deux. */
  listMyStatement(page: Page, account: string | undefined): Promise<Json>;
  createTopUp(input: { amount: number; idempotencyKey: string }): Promise<Json>;
  listMyPayouts(page: Page, status: string | undefined): Promise<Json>;
  getHolderWallet(holder: WalletHolder): Promise<Json>;
  listHolderStatement(holder: WalletHolder, page: Page, account: string | undefined): Promise<Json>;
  creditPrepaidWallet(
    holder: WalletHolder,
    input: {
      kind: string;
      amount: number;
      reason: string;
      paymentId?: string | undefined;
      idempotencyKey: string;
    },
  ): Promise<Json>;
  listWalletPayouts(
    page: Page,
    filters: { status?: string | undefined; holder?: WalletHolder | undefined },
  ): Promise<Json>;
  getLedgerOverview(): Promise<Json>;
}
