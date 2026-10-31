import { type Json, type Page } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur le service payment (ADR-031), indépendante de gRPC : l'adaptateur traduit
 * les corps REST en messages protobuf et les réponses en JSON du contrat OpenAPI. L'utilisateur
 * voyage dans le contexte de la requête.
 */
export interface PaymentInput {
  subjectType: 'cleaning_mission' | 'billing_invoice';
  subjectId: string;
  part?: 'deposit' | 'balance' | undefined;
}

export interface PaymentFilters {
  status?: string | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  customerId?: string | undefined;
  organizationId?: string | undefined;
}

/** Un appel par méthode du contrat ksp.payment.v1 exposée en REST. */
export interface PaymentApi {
  createPayment(input: PaymentInput, idempotencyKey: string): Promise<Json>;
  getMyPayment(id: string): Promise<Json>;
  listMyPayments(page: Page, status: string | undefined): Promise<Json>;
  simulatePayment(id: string, outcome: 'succeeded' | 'failed'): Promise<Json>;
  /** Notification du prestataire : corps exact et en-tête de signature, sans interprétation. */
  receiveWebhook(provider: 'fedapay', payload: Buffer, signature: string): Promise<Json>;
  listPayments(page: Page, filters: PaymentFilters): Promise<Json>;
}
