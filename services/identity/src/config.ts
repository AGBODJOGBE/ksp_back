import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';
import { type OtpPolicy } from './domain/otp/otp-policy';

/**
 * Configuration du service : variables communes, plus celles propres à identity.
 * Les règles des codes reprennent les valeurs du cahier des charges Identité (partie 4).
 */
export const configSchema = baseServiceConfigSchema.safeExtend({
  /** Clé secrète du HMAC des codes : sans elle, une fuite de la base ne révèle aucun code. */
  OTP_HMAC_SECRET: z.string().min(32, 'OTP_HMAC_SECRET doit faire au moins 32 caractères.'),
  OTP_CODE_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_DELAY_SECONDS: z.coerce.number().int().nonnegative().default(60),
  OTP_MAX_PER_HOUR: z.coerce.number().int().positive().default(5),
  OTP_MAX_PER_DAY: z.coerce.number().int().positive().default(10),
  OTP_BLOCK_SECONDS: z.coerce.number().int().positive().default(3600),
  /**
   * Clés de signature des jetons (ADR-020), fournies par le coffre à secrets : liste JSON
   * [{ kid, status: next | active | retired, privateKeyPem }]. Vide hors production : clé temporaire.
   */
  IDENTITY_SIGNING_KEYS: z.string().optional(),
  /** Durée de vie d'un jeton d'accès (cahier des charges Identité, partie 4 : 15 minutes). */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /**
   * Services autorisés à demander des jetons de service (ADR-022), fournis par le coffre :
   * { "<service>": { "secretSha256": "<hex>", "audiences": ["<service appelé>", …] } }.
   */
  SERVICE_CLIENTS: z.string().optional(),
  /** Durée de vie d'un jeton de service : 5 minutes. */
  SERVICE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Adresse gRPC du service notification (envoi des codes, ADR-014). */
  NOTIFICATION_GRPC_URL: z.string().min(1).default('localhost:50052'),
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function otpPolicyFrom(config: ServiceConfig): OtpPolicy {
  return {
    codeLength: config.OTP_CODE_LENGTH,
    ttlSeconds: config.OTP_TTL_SECONDS,
    maxAttempts: config.OTP_MAX_ATTEMPTS,
    resendDelaySeconds: config.OTP_RESEND_DELAY_SECONDS,
    maxPerHour: config.OTP_MAX_PER_HOUR,
    maxPerDay: config.OTP_MAX_PER_DAY,
    blockSeconds: config.OTP_BLOCK_SECONDS,
  };
}
