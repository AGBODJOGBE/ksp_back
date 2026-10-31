import { AppError } from '@ksp/platform';
import { Body, Controller, Headers, Inject, Param, Query } from '@nestjs/common';
import { type PaymentApi, type PaymentInput } from '../../application/payment/payment.ports';
import { PAYMENT_API, PAYMENT_SIMULATION_ROUTE } from '../../tokens';
import { idFrom, keyFrom, pageFrom } from './cleaning.controller';
import { parseParam } from './cleaning-schemas';
import { paymentParams } from './payment-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

type Query = Record<string, unknown>;

const statusFrom = (query: Query) => parseParam(paymentParams.status, query['status'], 'status');
const optionalId = (query: Query, name: string) => parseParam(paymentParams.optionalId, query[name], name);

/**
 * Routes /api/v1/payment/* (paiement en ligne par Mobile Money, ADR-031) et
 * /api/v1/admin/payment/* (back-office). Jamais de montant dans les requêtes : payment le lit dans
 * cleaning ou billing. Droits contrôlés par le garde d'après le manifeste, puis revérifiés par payment.
 */
@Controller()
export class PaymentHttpController {
  constructor(
    @Inject(PAYMENT_API) private readonly payments: PaymentApi,
    @Inject(PAYMENT_SIMULATION_ROUTE) private readonly simulationOpen: boolean,
  ) {}

  @Route('createPayment')
  create(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const idempotencyKey = keyFrom(key);
    return this.payments.createPayment(
      parseBody(requestBodies.createPayment, body) as PaymentInput,
      idempotencyKey,
    );
  }

  @Route('listMyPayments')
  listMine(@Query() query: Query) {
    const status = statusFrom(query);
    return this.payments.listMyPayments(pageFrom(query), status);
  }

  @Route('getMyPayment')
  getMine(@Param('id') id: unknown) {
    return this.payments.getMyPayment(idFrom(id));
  }

  /** Développement seulement : la route n'existe pas en production (payment la refuse aussi). */
  @Route('simulatePayment')
  simulate(@Param('id') id: unknown, @Body() body: unknown) {
    if (!this.simulationOpen) {
      throw AppError.notFound(
        'PAYMENT_SIMULATION_DISABLED',
        'La simulation de paiement n’est disponible qu’en développement.',
      );
    }
    const paymentId = idFrom(id);
    return this.payments.simulatePayment(paymentId, parseBody(requestBodies.simulatePayment, body).outcome);
  }

  /**
   * Notification de FedaPay : corps brut (lu par le middleware des notifications), transmis octet
   * pour octet avec l'en-tête de signature ; payment vérifie la signature. Rien n'est journalisé.
   */
  @Route('receiveFedapayWebhook')
  fedapayWebhook(@Body() body: unknown, @Headers('x-fedapay-signature') signature: unknown) {
    const header = parseParam(paymentParams.signature, signature, 'X-FEDAPAY-SIGNATURE');
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw AppError.invalid('GATEWAY_VALIDATION_FAILED', 'Notification vide.', {
        fields: [{ field: 'body', reason: 'required' }],
      });
    }
    return this.payments.receiveWebhook('fedapay', body, header);
  }

  @Route('listPayments')
  listAll(@Query() query: Query) {
    const filters = {
      status: statusFrom(query),
      subjectType: parseParam(paymentParams.subjectType, query['subjectType'], 'subjectType'),
      subjectId: optionalId(query, 'subjectId'),
      customerId: optionalId(query, 'customerId'),
      organizationId: optionalId(query, 'organizationId'),
    };
    return this.payments.listPayments(pageFrom(query), filters);
  }
}
