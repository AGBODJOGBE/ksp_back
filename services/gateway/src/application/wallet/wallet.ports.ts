import { type Json, type Page } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur le service wallet (ADR-042), indépendante de gRPC : lecture seule, les
 * écritures du grand livre viennent des services métier.
 */
export interface WalletHolder {
  type: 'user' | 'organization';
  id: string;
}

/** Un appel par méthode de ksp.wallet.v1 exposée en REST. */
export interface WalletApi {
  getMyWallet(): Promise<Json>;
  listMyStatement(page: Page): Promise<Json>;
  listMyPayouts(page: Page, status: string | undefined): Promise<Json>;
  getHolderWallet(holder: WalletHolder): Promise<Json>;
  listHolderStatement(holder: WalletHolder, page: Page): Promise<Json>;
  listWalletPayouts(
    page: Page,
    filters: { status?: string | undefined; holder?: WalletHolder | undefined },
  ): Promise<Json>;
  getLedgerOverview(): Promise<Json>;
}
