import { type Json, type Page } from '../cleaning/cleaning.ports';

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
}

export interface InvoicePaymentInput {
  amount: number;
  method: string;
  reference?: string | undefined;
}

/** Un appel par méthode du contrat ksp.billing.v1 exposée en REST. */
export interface BillingApi {
  listMyInvoices(page: Page, status: string | undefined): Promise<Json>;
  getMyInvoice(id: string): Promise<Json>;
  listInvoices(page: Page, filters: InvoiceFilters): Promise<Json>;
  getInvoice(id: string): Promise<Json>;
  recordInvoicePayment(id: string, input: InvoicePaymentInput): Promise<Json>;
  getSettings(): Promise<Json>;
  updateSettings(input: { paymentTermDays: number }): Promise<Json>;
}
