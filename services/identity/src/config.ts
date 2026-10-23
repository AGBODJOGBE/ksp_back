import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';
import { type MfaPolicy } from './domain/mfa/mfa-challenge';
import { type OtpPolicy } from './domain/otp/otp-policy';
import { type SessionCategory, type SessionPolicy } from './domain/session/session-policy';

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
  /** Durée du jeton de renouvellement des sites et applications : 30 jours, prolongée à chaque usage. */
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 3600),
  /** Sessions simultanées des sites et applications ; au-delà, la plus ancienne est révoquée. */
  MAX_SESSIONS: z.coerce.number().int().positive().default(5),
  /** Sessions du back-office : 12 heures sans prolongation, 2 sessions, fermeture après 30 minutes d'inactivité. */
  BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 3600),
  BACKOFFICE_MAX_SESSIONS: z.coerce.number().int().positive().default(2),
  BACKOFFICE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  /**
   * Clé AES-256-GCM des secrets de double authentification (32 octets en base64), fournie par le
   * coffre à secrets. Obligatoire en production ; vide ailleurs : clé temporaire.
   */
  IDENTITY_MFA_ENCRYPTION_KEY: z.string().optional(),
  /** Durée de vie du jeton de double authentification : 5 minutes. */
  MFA_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Codes faux acceptés par jeton de double authentification ; au-delà, il est annulé. */
  MFA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Adresse gRPC du service notification (envoi des codes, ADR-014). */
  NOTIFICATION_GRPC_URL: z.string().min(1).default('localhost:50052'),
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function sessionPolicyFrom(config: ServiceConfig): SessionPolicy {
  return { refreshTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS, maxSessions: config.MAX_SESSIONS };
}

export function backofficeSessionPolicyFrom(config: ServiceConfig): SessionPolicy {
  return {
    refreshTtlSeconds: config.BACKOFFICE_REFRESH_TOKEN_TTL_SECONDS,
    maxSessions: config.BACKOFFICE_MAX_SESSIONS,
    slidingExpiry: false,
    idleTimeoutSeconds: config.BACKOFFICE_IDLE_TIMEOUT_SECONDS,
  };
}

export function sessionPoliciesFrom(config: ServiceConfig): Record<SessionCategory, SessionPolicy> {
  return { customer: sessionPolicyFrom(config), backoffice: backofficeSessionPolicyFrom(config) };
}

export function mfaPolicyFrom(config: ServiceConfig): MfaPolicy {
  return { tokenTtlSeconds: config.MFA_TOKEN_TTL_SECONDS, maxAttempts: config.MFA_MAX_ATTEMPTS };
}

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
