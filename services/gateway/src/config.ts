import { z } from 'zod';
import { type ClientOrigins } from './domain/client/client-kind';
import { DEFAULT_RATE_LIMITS, type RateLimitTable } from './domain/rate-limit/rate-limits';

/** Liste d'origines séparées par des virgules, chacune de la forme https://hôte[:port], sans chemin. */
const origins = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z
        .string()
        .regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/, 'Origine attendue : https://hôte[:port], sans chemin.'),
    ),
  );

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);
const optionalUrl = z.preprocess(unset, z.url().optional());
const optionalText = z.preprocess(unset, z.string().min(1).optional());

const perMinute = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/**
 * Configuration de la gateway. Elle n'a ni base de données, ni RabbitMQ, ni serveur gRPC au lot 1 :
 * le schéma commun des services (baseServiceConfigSchema) ne s'applique donc pas, seules les
 * variables communes sont reprises sous les mêmes noms.
 */
export const configSchema = z
  .object({
    SERVICE_NAME: z.string().min(1).default('gateway'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalText,

    /** Adresse gRPC d'identity. */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    /** Clés publiques d'identity, sur son port HTTP interne (ADR-020). */
    IDENTITY_JWKS_URL: optionalUrl,
    /** Route d'émission des jetons de service d'identity (ADR-022) et secret de la gateway. */
    IDENTITY_TOKEN_URL: optionalUrl,
    SERVICE_CLIENT_SECRET: optionalText,
    JWKS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    JWKS_RELOAD_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(30),

    /** Délai d'un appel gRPC (cahier des charges Gateway, partie 4 : 3 secondes). */
    GRPC_DEADLINE_MS: z.coerce.number().int().positive().default(3000),
    /** Taille maximum d'un corps de requête (partie 4 : 1 Mo). */
    MAX_BODY_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024),

    /** Origines autorisées (UC-GW-14), qui fixent aussi le type de client : sites web et back-office. */
    CORS_WEB_ORIGINS: origins,
    CORS_BACKOFFICE_ORIGINS: origins,
    /**
     * Mandataires de confiance pour lire l'adresse IP du client (réglage « trust proxy » d'Express) :
     * nombre de sauts, ou liste d'adresses et de réseaux (loopback, uniquelocal, 10.42.0.0/16…).
     */
    TRUST_PROXY: optionalText,
    /**
     * Cookie de renouvellement sans Secure ni préfixe __Secure- : uniquement pour un front de
     * développement servi en HTTP hors localhost. Refusé en production.
     */
    REFRESH_COOKIE_INSECURE: z.stringbool().default(false),

    RATE_LIMIT_PUBLIC_PER_MINUTE: perMinute(DEFAULT_RATE_LIMITS.public.limit),
    RATE_LIMIT_AUTHENTICATED_PER_MINUTE: perMinute(DEFAULT_RATE_LIMITS.authenticated.limit),
    RATE_LIMIT_OTP_REQUEST_PER_MINUTE: perMinute(DEFAULT_RATE_LIMITS.otp_request.limit),
    RATE_LIMIT_OTP_VERIFY_PER_MINUTE: perMinute(DEFAULT_RATE_LIMITS.otp_verify.limit),
    RATE_LIMIT_REFRESH_PER_MINUTE: perMinute(DEFAULT_RATE_LIMITS.refresh.limit),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    const fail = (path: keyof typeof cfg, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (!cfg.IDENTITY_JWKS_URL) {
      fail('IDENTITY_JWKS_URL', 'Obligatoire en production : vérification des jetons d’accès.');
    }
    if (!cfg.IDENTITY_TOKEN_URL || !cfg.SERVICE_CLIENT_SECRET) {
      fail(
        'SERVICE_CLIENT_SECRET',
        'IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : appels authentifiés (ADR-022).',
      );
    }
    if (!cfg.TRUST_PROXY) {
      fail('TRUST_PROXY', 'Obligatoire en production : sans lui, l’adresse IP du client est fausse.');
    }
    if (cfg.REFRESH_COOKIE_INSECURE) {
      fail(
        'REFRESH_COOKIE_INSECURE',
        'Interdit en production : le cookie de renouvellement doit être Secure.',
      );
    }
    if (cfg.CORS_WEB_ORIGINS.length === 0 || cfg.CORS_BACKOFFICE_ORIGINS.length === 0) {
      fail('CORS_WEB_ORIGINS', 'Les origines des sites et du back-office sont obligatoires en production.');
    }
    for (const origin of [...cfg.CORS_WEB_ORIGINS, ...cfg.CORS_BACKOFFICE_ORIGINS]) {
      if (!origin.startsWith('https://'))
        fail('CORS_WEB_ORIGINS', `Origine non HTTPS en production : ${origin}`);
    }
  });

export type GatewayConfig = z.infer<typeof configSchema>;

/** Adresse JWKS par défaut en développement : identity lancé en local (port HTTP 3101). */
export const DEV_IDENTITY_JWKS_URL = 'http://localhost:3101/.well-known/jwks.json';

export function clientOriginsFrom(config: GatewayConfig): ClientOrigins {
  return { web: config.CORS_WEB_ORIGINS, backoffice: config.CORS_BACKOFFICE_ORIGINS };
}

export function rateLimitsFrom(config: GatewayConfig): RateLimitTable {
  return {
    public: { ...DEFAULT_RATE_LIMITS.public, limit: config.RATE_LIMIT_PUBLIC_PER_MINUTE },
    authenticated: {
      ...DEFAULT_RATE_LIMITS.authenticated,
      limit: config.RATE_LIMIT_AUTHENTICATED_PER_MINUTE,
    },
    otp_request: { ...DEFAULT_RATE_LIMITS.otp_request, limit: config.RATE_LIMIT_OTP_REQUEST_PER_MINUTE },
    otp_verify: { ...DEFAULT_RATE_LIMITS.otp_verify, limit: config.RATE_LIMIT_OTP_VERIFY_PER_MINUTE },
    refresh: { ...DEFAULT_RATE_LIMITS.refresh, limit: config.RATE_LIMIT_REFRESH_PER_MINUTE },
  };
}

/** Valeur du réglage « trust proxy » d'Express : un nombre de sauts, ou une liste. */
export function trustProxyFrom(config: GatewayConfig): number | string {
  const raw = config.TRUST_PROXY?.trim() || 'loopback';
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}
