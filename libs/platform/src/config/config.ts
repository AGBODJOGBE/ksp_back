import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Variables communes à tous les services. Chaque service étend ce schéma avec ses propres variables :
 *   const schema = baseServiceConfigSchema.safeExtend({ OTP_TTL_SECONDS: z.coerce.number().default(300) });
 */
export const baseServiceConfigSchema = z
  .object({
    SERVICE_NAME: z.string().min(1),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    GRPC_PORT: z.coerce.number().int().min(1).max(65535),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535),
    DATABASE_URL: z.string().min(1),
    RABBITMQ_URL: z.string().min(1),
    /** Clés publiques d'identity pour vérifier les jetons de service (ADR-013). Obligatoire en production. */
    IDENTITY_JWKS_URL: z.string().optional(),
    SERVICE_TOKEN_ISSUER: z.string().default('ksp-identity'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .refine((cfg) => cfg.NODE_ENV !== 'production' || Boolean(cfg.IDENTITY_JWKS_URL), {
    message:
      'IDENTITY_JWKS_URL est obligatoire en production : les appels entre services doivent être authentifiés.',
    path: ['IDENTITY_JWKS_URL'],
  });

export type BaseServiceConfig = z.infer<typeof baseServiceConfigSchema>;

/**
 * Lit et valide la configuration. Le service refuse de démarrer si une variable manque ou est invalide :
 * mieux vaut un échec immédiat et lisible qu'une erreur en plein trafic.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `- ${issue.path.join('.') || '(racine)'} : ${issue.message}`,
    );
    throw new ConfigError(`Configuration invalide :\n${lines.join('\n')}`);
  }
  return result.data;
}
