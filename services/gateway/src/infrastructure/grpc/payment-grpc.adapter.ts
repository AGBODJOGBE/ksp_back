import { type Metadata } from '@grpc/grpc-js';
import { type paymentV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type Json, type Page } from '../../application/cleaning/cleaning.ports';
import {
  type PaymentApi,
  type PaymentFilters,
  type PaymentInput,
} from '../../application/payment/payment.ports';
import { toUpstreamError } from './upstream-error';

export interface PaymentClients {
  payments: paymentV1.PaymentServiceClient;
  webhooks: paymentV1.PaymentWebhookServiceClient;
  admin: paymentV1.PaymentAdminServiceClient;
}

/** Réponse de payment qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de payment inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);
/**
 * Délais propres aux appels qui interrogent le prestataire (5 secondes par appel chez lui) : la
 * création en fait deux (transaction, page de paiement) après la lecture du montant dû.
 */
const PROVIDER_DEADLINES_MS = {
  createPayment: 15_000,
  simulatePayment: 10_000,
  receiveProviderNotification: 10_000,
  getMyPayment: 8_000,
} as const;
const page = (value: Page): paymentV1.Page => ({ limit: value.limit ?? 0, cursor: value.cursor ?? '' });

/** Traduction d'un paiement ksp.payment.v1 vers le JSON du contrat OpenAPI. */
export function presentPayment(value: paymentV1.Payment | undefined) {
  if (!value?.subject) throw malformed('paiement');
  return {
    id: value.id,
    status: value.status,
    subject: {
      type: value.subject.type,
      id: value.subject.id,
      part: orNull(value.subject.part),
      reference: orNull(value.subject.reference),
    },
    amount: { amount: Number(value.amount?.amount ?? 0), currency: value.amount?.currency || 'XOF' },
    customerId: value.customerId,
    organizationId: orNull(value.organizationId),
    method: value.method,
    provider: value.provider,
    providerReference: orNull(value.providerReference),
    checkoutUrl: orNull(value.checkoutUrl),
    failureReason: orNull(value.failureReason),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    completedAt: orNull(value.completedAt),
  };
}

const deadline = (name: string): { deadlineMs?: number } =>
  name in PROVIDER_DEADLINES_MS
    ? { deadlineMs: PROVIDER_DEADLINES_MS[name as keyof typeof PROVIDER_DEADLINES_MS] }
    : {};

const list = (res: { payments: paymentV1.Payment[]; nextCursor: string }) => ({
  data: res.payments.map(presentPayment),
  nextCursor: res.nextCursor || null,
});

/**
 * Client gRPC de payment : délai, coupe-circuit et jeton de service par GrpcCaller. Seules les
 * lectures sont rejouées ; une écriture (création, simulation, notification) ne l'est jamais.
 * Aucun journal du contenu : la notification du prestataire porte les coordonnées du payeur.
 */
export class PaymentGrpcAdapter implements PaymentApi {
  private readonly logger = new Logger('PaymentGrpc');

  constructor(
    private readonly clients: PaymentClients,
    private readonly caller: GrpcCaller,
  ) {}

  async createPayment(input: PaymentInput, idempotencyKey: string): Promise<Json> {
    const res = await this.write('createPayment', (m) =>
      this.clients.payments.createPayment(
        {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          part: input.part ?? '',
          idempotencyKey,
        },
        m,
      ),
    );
    return presentPayment(res.payment);
  }

  async getMyPayment(id: string): Promise<Json> {
    const res = await this.read('getMyPayment', (m) =>
      this.clients.payments.getMyPayment({ paymentId: id }, m),
    );
    return presentPayment(res.payment);
  }

  async listMyPayments(value: Page, status: string | undefined): Promise<Json> {
    return list(
      await this.read('listMyPayments', (m) =>
        this.clients.payments.listMyPayments({ page: page(value), status: status ?? '' }, m),
      ),
    );
  }

  async simulatePayment(id: string, outcome: 'succeeded' | 'failed'): Promise<Json> {
    const res = await this.write('simulatePayment', (m) =>
      this.clients.payments.simulatePayment({ paymentId: id, outcome }, m),
    );
    return presentPayment(res.payment);
  }

  async receiveWebhook(provider: 'fedapay', payload: Buffer, signature: string): Promise<Json> {
    await this.write('receiveProviderNotification', (m) =>
      this.clients.webhooks.receiveProviderNotification({ provider, payload, signature }, m),
    );
    return { received: true };
  }

  async listPayments(value: Page, filters: PaymentFilters): Promise<Json> {
    return list(
      await this.read('listPayments', (m) =>
        this.clients.admin.listPayments(
          {
            page: page(value),
            status: filters.status ?? '',
            subjectType: filters.subjectType ?? '',
            subjectId: filters.subjectId ?? '',
            customerId: filters.customerId ?? '',
            organizationId: filters.organizationId ?? '',
          },
          m,
        ),
      ),
    );
  }

  // --- Appels -----------------------------------------------------------------------------------

  private read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, { idempotent: true, ...deadline(name) });
  }

  private write<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, deadline(name));
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean; deadlineMs?: number },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('payment', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`payment.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
