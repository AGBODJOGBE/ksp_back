import { type NestExpressApplication } from '@nestjs/platform-express';
import { clientOriginsFrom, type GatewayConfig, trustProxyFrom } from '../../config';
import { GatewayExceptionFilter } from './error-response';
import { PAYMENT_WEBHOOK_PREFIX } from '../../domain/routing/payment-routes';
import { type GatewayRequest, type GatewayResponse, type Next } from './http-types';
import { rawBody } from './raw-body';
import { CORRELATION_HEADER, correlationMiddleware } from './request-context';

/**
 * En-têtes de sécurité standards (cahier des charges Gateway, partie 8). L'API ne sert que du JSON :
 * aucun contenu actif, aucune mise en cache par défaut (les réponses portent des jetons).
 */
function securityHeaders(_request: GatewayRequest, response: GatewayResponse, next: Next): void {
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Chaîne HTTP de la gateway, commune au démarrage et aux tests (l'application doit être créée
 * avec bodyParser: false) : corrélation, en-têtes de sécurité, CORS, corps JSON de 1 Mo au plus
 * (corps brut de 64 Ko pour les notifications des prestataires de paiement),
 * format d'erreur unique.
 */
export function configureHttpApp(app: NestExpressApplication, config: GatewayConfig): void {
  app.set('trust proxy', trustProxyFrom(config));
  app.disable('x-powered-by');
  app.use(correlationMiddleware);
  app.use(securityHeaders);

  const origins = clientOriginsFrom(config);
  const allowed = [...origins.web, ...origins.backoffice];
  // Seules les origines de l'environnement reçoivent les en-têtes CORS (UC-GW-14) ; cookie compris.
  app.enableCors({
    origin: allowed.length > 0 ? allowed : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Version', 'Idempotency-Key'],
    exposedHeaders: [CORRELATION_HEADER, 'Retry-After'],
    maxAge: 600,
  });

  // Notifications des prestataires : corps brut (signature sur les octets exacts), avant l'analyse JSON.
  app.use(PAYMENT_WEBHOOK_PREFIX, rawBody());
  app.useBodyParser('json', { limit: config.MAX_BODY_BYTES });
  app.useGlobalFilters(new GatewayExceptionFilter());
}
