import { type Json, type Page } from '../common/api.ports';

/**
 * Vue de la gateway sur le service billing, indépendante de gRPC : l'adaptateur traduit les
 * corps REST en messages protobuf et les réponses en JSON du contrat OpenAPI. L'utilisateur
 * voyage dans le contexte de la requête.
 */
export interface InvoiceFilters {
  status?: string | undefined;
  customerId?: string | undefined;
  organizationId?: string | undefined;
  contractId?: string | undefined;
  /** Période facturée, dates AAAA-MM-JJ (heure du Bénin), bornes incluses. */
  from?: string | undefined;
  to?: string | undefined;
}

export interface InvoicePaymentInput {
  amount: number;
  method: string;
  reference?: string | undefined;
  /** En-tête Idempotency-Key, facultatif. */
  idempotencyKey?: string | undefined;
}

/** Recouvrement (ADR-064) : filtres des factures de commission. */
export interface CommissionInvoiceFilters {
  status?: string | undefined;
  /** Mois facturé AAAA-MM (heure du Bénin). */
  period?: string | undefined;
  /** Back-office seulement : créancier (compte ou organisation). */
  creditorId?: string | undefined;
}

/** Un appel par méthode du contrat ksp.billing.v1 exposée en REST. */
export interface BillingApi {
  listMyInvoices(page: Page, status: string | undefined): Promise<Json>;
  getMyInvoice(id: string): Promise<Json>;
  /** Reste dû payé depuis le portefeuille prépayé (ADR-046). */
  payMyInvoiceFromWallet(id: string, idempotencyKey: string): Promise<Json>;
  listInvoices(page: Page, filters: InvoiceFilters): Promise<Json>;
  getInvoice(id: string): Promise<Json>;
  recordInvoicePayment(id: string, input: InvoicePaymentInput): Promise<Json>;
  getSettings(): Promise<Json>;
  updateSettings(input: { paymentTermDays: number }): Promise<Json>;
  // Recouvrement (ADR-064) : factures de commission et reçus des frais de dossier.
  listMyCommissionInvoices(page: Page, filters: CommissionInvoiceFilters): Promise<Json>;
  getMyCommissionInvoice(id: string): Promise<Json>;
  listMyFeeReceipts(page: Page, caseId: string | undefined): Promise<Json>;
  listCommissionInvoices(page: Page, filters: CommissionInvoiceFilters): Promise<Json>;
  getCommissionInvoice(id: string): Promise<Json>;
}
