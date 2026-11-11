import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);

/** Liste de services séparés par des virgules (noms des jetons de service). */
const serviceList = (fallback: string) =>
  z
    .preprocess(unset, z.string().default(fallback))
    .transform((value) =>
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1));

/** Clé de développement de l'empreinte des numéros : refusée en production. */
export const DEV_PHONE_HASH_SECRET = 'ksp-dev-wallet-phone-hash-secret-not-for-production';

/**
 * Configuration du service : variables communes, plus celles propres à wallet (ADR-042, ADR-046).
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Services autorisés à écrire dans le grand livre et à lire les titulaires (jeton de service). */
    WALLET_LEDGER_CALLERS: serviceList('recovery'),
    /** Services autorisés à débiter et rembourser les portefeuilles prépayés (ADR-046). */
    WALLET_DEBIT_CALLERS: serviceList('cleaning,billing'),
    /** Montants de recharge acceptés, en XOF entiers (ADR-046). */
    WALLET_TOP_UP_MIN: z.coerce.number().int().min(1).default(500),
    WALLET_TOP_UP_MAX: z.coerce.number().int().min(1).max(1_000_000_000).default(1_000_000),
    /** Adresse gRPC de payment (reversements, recharges). */
    PAYMENT_GRPC_URL: z.string().min(1).default('localhost:50055'),
    /**
     * Clé de l'empreinte des numéros de bénéficiaire (HMAC-SHA256, 32 caractères au moins), fournie
     * par le coffre, jamais journalisée ; celle de développement est refusée en production (ADR-048).
     */
    WALLET_PHONE_HASH_SECRET: z.preprocess(unset, z.string().min(32).default(DEV_PHONE_HASH_SECRET)),
    /** Transmission planifiée des reversements en attente (1 minute) ; 0 : désactivée. */
    WALLET_PAYOUT_SUBMIT_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.WALLET_TOP_UP_MIN > cfg.WALLET_TOP_UP_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['WALLET_TOP_UP_MIN'],
        message: 'WALLET_TOP_UP_MIN doit être inférieur ou égal à WALLET_TOP_UP_MAX.',
      });
    }
    if (cfg.NODE_ENV !== 'production') return;
    if (cfg.WALLET_PHONE_HASH_SECRET === DEV_PHONE_HASH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['WALLET_PHONE_HASH_SECRET'],
        message: 'Clé propre à la production obligatoire (coffre).',
      });
    }
    if (!cfg.IDENTITY_TOKEN_URL || !cfg.SERVICE_CLIENT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SERVICE_CLIENT_SECRET'],
        message:
          'IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : wallet transmet les reversements à payment (ADR-022).',
      });
    }
  });

export type ServiceConfig = z.infer<typeof configSchema>;
