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
/** Jeton d'un lien : un jeton mal formé ne révèle rien de plus qu'un jeton inconnu (404). */
const tokenFrom = (token: unknown): string => {
  const parsed = paymentParams.linkToken.safeParse(token);
  if (!parsed.success) {
    throw AppError.notFound('PAYMENT_LINK_NOT_FOUND', 'Ce lien de paiement est introuvable.');
  }
  return parsed.data;
};
const underReviewFrom = (query: Query) => {
  const value = parseParam(paymentParams.underReview, query['underReview'], 'underReview');
  return value === undefined ? undefined : value === 'true';
};

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
      underReview: underReviewFrom(query),
    };
    return this.payments.listPayments(pageFrom(query), filters);
  }

  /** Page publique d'un lien de paiement (ADR-040). Jeton mal formé : introuvable, comme un jeton inconnu. */
  @Route('getPaymentLink')
  getLink(@Param('token') token: unknown) {
    return this.payments.getPaymentLink(tokenFrom(token));
  }

  @Route('payPaymentLink')
  payLink(@Param('token') token: unknown, @Headers('idempotency-key') key: unknown) {
    const linkToken = tokenFrom(token);
    return this.payments.payPaymentLink(linkToken, keyFrom(key));
  }

  /** Développement seulement : la route n'existe pas en production (payment la refuse aussi). */
  @Route('simulatePaymentLinkPayment')
  simulateLink(@Param('token') token: unknown, @Body() body: unknown) {
    if (!this.simulationOpen) {
      throw AppError.notFound(
        'PAYMENT_SIMULATION_DISABLED',
        'La simulation de paiement n’est disponible qu’en développement.',
      );
    }
    const linkToken = tokenFrom(token);
    return this.payments.simulatePaymentLinkPayment(
      linkToken,
      parseBody(requestBodies.simulatePaymentLinkPayment, body).outcome,
    );
  }

  /** Reversements (ADR-041), back-office de la finance. */
  @Route('listPayouts')
  listPayouts(@Query() query: Query) {
    const filters = {
      status: parseParam(paymentParams.payoutStatus, query['status'], 'status'),
      issuer: parseParam(paymentParams.issuer, query['issuer'], 'issuer'),
    };
    return this.payments.listPayouts(pageFrom(query), filters);
  }

  @Route('confirmPayout')
  confirmPayout(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const payoutId = idFrom(id);
    const idempotencyKey = parseParam(paymentParams.optionalIdempotencyKey, key, 'Idempotency-Key');
    const { transferReference } = parseBody(requestBodies.confirmPayout, body);
    return this.payments.confirmPayout(payoutId, { text: transferReference, idempotencyKey });
  }

  @Route('failPayout')
  failPayout(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const payoutId = idFrom(id);
    const idempotencyKey = parseParam(paymentParams.optionalIdempotencyKey, key, 'Idempotency-Key');
    const { reason } = parseBody(requestBodies.failPayout, body);
    return this.payments.failPayout(payoutId, { text: reason, idempotencyKey });
  }

  /** La finance a traité un écart de montant : les nouveaux paiements de l'objet ne sont plus bloqués. */
  @Route('resolvePaymentMismatch')
  resolveMismatch(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const paymentId = idFrom(id);
    // Facultative, comme pour l'encaissement manuel d'une facture.
    const idempotencyKey = parseParam(paymentParams.optionalIdempotencyKey, key, 'Idempotency-Key');
    return this.payments.resolveAmountMismatch(paymentId, {
      ...parseBody(requestBodies.resolvePaymentMismatch, body),
      idempotencyKey,
    });
  }
}
