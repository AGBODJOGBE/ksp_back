import {
  AppError,
  currentContext,
  type ErrorDetails,
  grpcStatusOf,
  HTTP_STATUS_BY_GRPC,
  newCorrelationId,
} from '@ksp/platform';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type GatewayRequest, type GatewayResponse } from './http-types';

/** Corps d'erreur unique de l'API (cahier des charges Gateway, partie 6). */
export interface ErrorBody {
  error: { code: string; message: string; details: ErrorDetails; correlationId: string };
}

interface HttpError {
  status: number;
  code: string;
  message: string;
  details: ErrorDetails;
}

const GENERIC_MESSAGE = 'Une erreur interne est survenue. Réessayez plus tard.';
const INVALID_BODY = 'Le corps de la requête est invalide.';

/** Erreurs du lecteur de corps JSON (http-errors) : statut et type, sans autre détail exploitable. */
interface BodyParserError {
  status?: number;
  statusCode?: number;
  type?: string;
}

/**
 * Traduit toute erreur en réponse HTTP (UC-GW-06) : statut selon la table gRPC → HTTP du kit,
 * code et message destinés au front. Une erreur interne garde son code mais jamais son message :
 * aucun détail technique (trace, adresse, requête) ne sort de la gateway.
 */
export function toHttpError(exception: unknown, logger?: Logger): HttpError {
  if (exception instanceof AppError) {
    const status = HTTP_STATUS_BY_GRPC[grpcStatusOf(exception.kind)] ?? 500;
    if (exception.kind === 'INTERNAL') {
      logger?.error(`${exception.code} : ${exception.message}`);
      return { status, code: exception.code, message: GENERIC_MESSAGE, details: {} };
    }
    return { status, code: exception.code, message: exception.message, details: exception.details ?? {} };
  }
  const parser = exception as BodyParserError;
  const status =
    exception instanceof HttpException ? exception.getStatus() : (parser?.status ?? parser?.statusCode);
  if (status === 404) {
    return { status, code: 'GATEWAY_ROUTE_NOT_FOUND', message: "Cette adresse n'existe pas.", details: {} };
  }
  if (status === 413 || parser?.type === 'entity.too.large') {
    return {
      status: 413,
      code: 'GATEWAY_PAYLOAD_TOO_LARGE',
      message: 'La requête est trop volumineuse.',
      details: {},
    };
  }
  // JSON mal formé (SyntaxError convertie en 400 par NestJS), encodage ou jeu de caractères refusé.
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status: 400, code: 'GATEWAY_VALIDATION_FAILED', message: INVALID_BODY, details: {} };
  }
  logger?.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
  return { status: 500, code: 'GATEWAY_INTERNAL_ERROR', message: GENERIC_MESSAGE, details: {} };
}

/** Délai d'attente annoncé sur une réponse 429 (en-tête Retry-After, au moins 1 seconde). */
function retryAfterSeconds(details: ErrorDetails): number {
  const value = Number(details['retryAfterSeconds']);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 60;
}

/** Filtre global : toutes les erreurs, y compris celles des routes inconnues et du lecteur de corps. */
@Catch()
export class GatewayExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GatewayError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<GatewayRequest>();
    const response = http.getResponse<GatewayResponse>();
    if (response.headersSent) return;

    const error = toHttpError(exception, this.logger);
    const correlationId = request.correlationId ?? currentContext()?.correlationId ?? newCorrelationId();
    response.setHeader('X-Correlation-Id', correlationId);
    response.setHeader('Cache-Control', 'no-store');
    if (error.status === 429) response.setHeader('Retry-After', String(retryAfterSeconds(error.details)));
    const body: ErrorBody = {
      error: { code: error.code, message: error.message, details: error.details, correlationId },
    };
    response.status(error.status).json(body);
  }
}
