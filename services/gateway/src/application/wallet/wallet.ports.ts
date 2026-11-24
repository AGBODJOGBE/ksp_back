import { type Json, type Page } from '../common/api.ports';

/**
 * Vue de la gateway sur le service wallet (ADR-042, ADR-046), indépendante de gRPC : lectures,
 * recharge du portefeuille prépayé et crédit manuel de la finance ; les débits viennent des
 * services métier.
 */
export interface WalletHolder {
  type: 'user' | 'organization';
  id: string;
}

/** Objet d'un service à régler aussitôt par le portefeuille (v2, R-WL-05, R-PE-04). */
export interface WalletObject {
  service?: string | undefined;
  objectType: string;
  objectId: string;
  part?: string | null | undefined;
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
      /** v2 : reçu de caisse ou référence du virement (R-WL-02). */
      receiptReference?: string | undefined;
      forObject?: WalletObject | undefined;
      idempotencyKey: string;
    },
  ): Promise<Json>;
  /** `status` : `pending_approval` ou `approved`, absent pour toutes (ADR-048). */
  listManualCreditRequests(page: Page, status: string | undefined): Promise<Json>;
  approveManualCredit(requestId: string): Promise<Json>;
  listWalletPayouts(
    page: Page,
    filters: { status?: string | undefined; holder?: WalletHolder | undefined },
  ): Promise<Json>;
  getLedgerOverview(): Promise<Json>;
  /** Retrait vers Mobile Money sur demande du client (R-WL-04) : traité puis validé par la finance. */
  requestWithdrawal(input: {
    amount: number;
    beneficiary: { phone: string; operator: string; name: string };
    idempotencyKey: string;
  }): Promise<Json>;
  listMyWithdrawals(page: Page, status: string | undefined): Promise<Json>;
  rejectManualCredit(requestId: string, reason: string): Promise<Json>;
  listWithdrawals(
    page: Page,
    filters: { status?: string | undefined; holder?: WalletHolder | undefined },
  ): Promise<Json>;
  processWithdrawal(withdrawalId: string, note: string): Promise<Json>;
  /** Deuxième personne de la finance : jamais celle qui a traité (R-WL-04, revérifié par wallet). */
  approveWithdrawal(withdrawalId: string): Promise<Json>;
  rejectWithdrawal(withdrawalId: string, reason: string): Promise<Json>;
}
