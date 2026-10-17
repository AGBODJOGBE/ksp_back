import { LoggerModule } from 'nestjs-pino';
import { currentContext } from '../context/request-context';

/**
 * Champs jamais écrits en clair dans les journaux : jetons, mots de passe, codes, secrets
 * (cahier des charges Gateway, partie 8). Les numéros de téléphone sont masqués.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.newPassword',
  '*.code',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.mfaToken',
  '*.secret',
  '*.variables',
  '*.phoneE164',
];

export function createLoggerModule(serviceName: string, level: string) {
  return LoggerModule.forRoot({
    pinoHttp: {
      level,
      base: { service: serviceName },
      redact: { paths: REDACTED_PATHS, censor: '[masqué]' },
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
