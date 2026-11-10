import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';
import { type CodePolicy } from './domain/code-policy';

/** Secret de développement du .env.example : connu de tous, refusé en production (ADR-050). */
export const DEV_CODE_HMAC_SECRET = 'dev-only-document-code-hmac-secret-0123456789';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);

/**
 * Configuration du service : variables communes, plus celles propres à document (ADR-044). La clé
 * HMAC des codes vient du coffre en production, jamais du dépôt ; elle n'est jamais journalisée.
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Adresses gRPC des services appelés (jeton de service, ADR-022). */
    FILE_GRPC_URL: z.string().min(1).default('localhost:50056'),
    NOTIFICATION_GRPC_URL: z.string().min(1).default('localhost:50052'),
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    /** Clé secrète du HMAC des codes de signature : sans elle, une fuite de la base ne révèle rien. */
    DOCUMENT_CODE_HMAC_SECRET: z
      .string()
      .min(32, 'DOCUMENT_CODE_HMAC_SECRET doit faire au moins 32 caractères.'),
    /** Adresse publique de « Mon espace KSP », pour les liens de signature (HTTPS en production). */
    PORTAL_BASE_URL: z.url().default('https://ksp.bj'),
    /** Fuseau des dates imprimées (documents, certificat, messages). */
    DOCUMENT_TIME_ZONE: z.string().min(1).default('Africa/Porto-Novo'),
    /** Émetteur imprimé dans l'en-tête et le pied de page des documents. */
    DOCUMENT_ISSUER_NAME: z.string().min(1).max(100).default('Groupe KSP'),
    DOCUMENT_ISSUER_ADDRESS: z.string().min(1).max(200).default('Cotonou, Bénin'),
    /** Mentions légales (RCCM, IFU…) du pied de page ; à renseigner avant la production. */
    DOCUMENT_ISSUER_LEGAL_DETAILS: z.string().max(200).default(''),
    /** Modèle de test « generic » : ouvert hors production par défaut, interdit en production. */
    DOCUMENT_GENERIC_TEMPLATE_ENABLED: z.preprocess(unset, z.stringbool().optional()),
    /** Services métier autorisés à appeler DocumentInternalService, séparés par des virgules. */
    DOCUMENT_INTERNAL_CALLERS: z
      .string()
      .default('recovery,cleaning,billing')
      .transform((raw) =>
        raw
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'Nom de service invalide.'))),
    /** Codes de signature : validité, essais, délai entre deux envois, envois par heure. */
    DOCUMENT_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
    DOCUMENT_CODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    /** Essais en tout par demande, tous codes confondus ; au-delà, la demande est close (ADR-050). */
    DOCUMENT_SIGNATURE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(15),
    DOCUMENT_CODE_RESEND_DELAY_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
    DOCUMENT_CODE_MAX_PER_HOUR: z.coerce.number().int().min(1).max(20).default(5),
    /** Jours pendant lesquels le lien de signature reste lisible après la signature (ADR-050). */
    DOCUMENT_SIGNED_LINK_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** Intervalle de la clôture des demandes expirées (10 minutes) ; 0 : désactivée. */
    DOCUMENT_EXPIRY_INTERVAL_MS: z.coerce.number().int().min(0).default(600_000),
    /** Délai d'un envoi ou d'une lecture du PDF dans le stockage. */
    DOCUMENT_TRANSFER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (cfg.DOCUMENT_CODE_HMAC_SECRET === DEV_CODE_HMAC_SECRET) {
      fail(
        'DOCUMENT_CODE_HMAC_SECRET',
        'Secret de développement refusé en production : secret propre fourni par le coffre.',
      );
    }
    if (cfg.DOCUMENT_GENERIC_TEMPLATE_ENABLED) {
      fail('DOCUMENT_GENERIC_TEMPLATE_ENABLED', 'Le modèle de test est interdit en production.');
    }
    if (!cfg.PORTAL_BASE_URL.startsWith('https://')) {
      fail('PORTAL_BASE_URL', 'Adresse HTTPS obligatoire en production (liens de signature).');
    }
    if (!cfg.IDENTITY_TOKEN_URL || !cfg.SERVICE_CLIENT_SECRET) {
      fail(
        'SERVICE_CLIENT_SECRET',
        'Jeton de service obligatoire en production (appels à file, notification, identity).',
      );
    }
  });

export type ServiceConfig = z.infer<typeof configSchema>;

export function genericTemplateEnabled(config: ServiceConfig): boolean {
  return config.DOCUMENT_GENERIC_TEMPLATE_ENABLED ?? config.NODE_ENV !== 'production';
}

export function codePolicyOf(config: ServiceConfig): CodePolicy {
  return {
    length: 6,
    ttlSeconds: config.DOCUMENT_CODE_TTL_SECONDS,
    maxAttempts: config.DOCUMENT_CODE_MAX_ATTEMPTS,
    maxAttemptsPerRequest: config.DOCUMENT_SIGNATURE_MAX_ATTEMPTS,
    resendDelaySeconds: config.DOCUMENT_CODE_RESEND_DELAY_SECONDS,
    maxPerHour: config.DOCUMENT_CODE_MAX_PER_HOUR,
  };
}
