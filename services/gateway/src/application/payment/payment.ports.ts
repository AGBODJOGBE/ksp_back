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
  /** true : écarts de montant à traiter ; false : tous les autres ; absent : pas de filtre. */
  underReview?: boolean | undefined;
}

/** Traitement d'un écart de montant par la finance (ADR-032). */
export interface MismatchResolutionInput {
  note: string;
  /** En-tête Idempotency-Key, facultatif. */
  idempotencyKey?: string | undefined;
}

/** Filtres de la liste des reversements (back-office, ADR-041). */
export interface PayoutFilters {
  status?: string | undefined;
  issuer?: string | undefined;
}

/** Décision de la finance sur un reversement manuel : référence du virement ou raison de l'échec. */
export interface PayoutSettlementInput {
  text: string;
  /** En-tête Idempotency-Key, facultatif. */
  idempotencyKey?: string | undefined;
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
  resolveAmountMismatch(id: string, input: MismatchResolutionInput): Promise<Json>;
  /** Page publique d'un lien de paiement (ADR-040), sans donnée personnelle. */
  getPaymentLink(token: string): Promise<Json>;
  payPaymentLink(token: string, idempotencyKey: string): Promise<Json>;
  simulatePaymentLinkPayment(token: string, outcome: 'succeeded' | 'failed'): Promise<Json>;
  /** Reversements (ADR-041). */
  listPayouts(page: Page, filters: PayoutFilters): Promise<Json>;
  confirmPayout(id: string, input: PayoutSettlementInput): Promise<Json>;
  failPayout(id: string, input: PayoutSettlementInput): Promise<Json>;
}
