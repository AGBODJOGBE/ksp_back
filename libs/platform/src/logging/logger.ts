import { LoggerModule } from 'nestjs-pino';
import { currentContext } from '../context/request-context';

/**
 * Champs jamais écrits en clair dans les journaux : jetons, mots de passe, codes, secrets
 * (cahier des charges Gateway, partie 8). Les numéros de téléphone sont masqués.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  // Cookie de renouvellement posé par la gateway.
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.code',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.mfaToken',
  '*.secret',
  '*.client_secret',
  '*.clientSecret',
  '*.variables',
  '*.phoneE164',
  // Lieu d'intervention (ADR-034) : position GPS, repère et adresse sont des données personnelles.
  '*.latitude',
  '*.longitude',
  '*.location',
  '*.landmark',
  '*.address',
  '*.geocodedAddress',
  '*.displayAddress',
];

/**
 * Segments d'adresse qui sont des secrets (jeton d'un lien de signature, ADR-044) : remplacés par
 * « [masqué] » dans l'adresse et les paramètres de route journalisés par chaque requête HTTP.
 */
const SECRET_PATHS: readonly RegExp[] = [/^(\/api\/v1\/document\/sign\/)[^/?#]+/];

export function maskSecretPaths(url: string | undefined): string | undefined {
  return url === undefined
    ? url
    : SECRET_PATHS.reduce((acc, pattern) => acc.replace(pattern, '$1[masqué]'), url);
}

/** Requête journalisée (forme de pino-std-serializers) : adresse et jeton de route masqués. */
export function serializeRequest<T extends { url?: string; params?: Record<string, unknown> }>(
  request: T,
): T {
  request.url = maskSecretPaths(request.url);
  if (request.params && 'token' in request.params) request.params = { ...request.params, token: '[masqué]' };
  return request;
}

export function createLoggerModule(serviceName: string, level: string) {
  return LoggerModule.forRoot({
    pinoHttp: {
      level,
      base: { service: serviceName },
      redact: { paths: REDACTED_PATHS, censor: '[masqué]' },
      serializers: { req: serializeRequest },
      // Chaque ligne porte l'identifiant de corrélation : on retrouve un parcours dans tous les services.
      mixin: () => {
        const context = currentContext();
        return context ? { correlationId: context.correlationId, causationId: context.causationId } : {};
      },
      // Les sondes de santé ne polluent pas les journaux.
      autoLogging: { ignore: (request) => request.url?.startsWith('/health') ?? false },
    },
  });
}
