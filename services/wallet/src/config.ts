import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);

/**
 * Configuration du service : variables communes, plus celles propres à wallet (ADR-042).
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Services autorisés à écrire dans le grand livre et à lire les titulaires (jeton de service). */
    WALLET_LEDGER_CALLERS: z
      .preprocess(unset, z.string().default('recovery'))
      .transform((value) =>
        value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1)),
    /** Adresse gRPC de payment (reversements). */
    PAYMENT_GRPC_URL: z.string().min(1).default('localhost:50055'),
    /** Transmission planifiée des reversements en attente (1 minute) ; 0 : désactivée. */
    WALLET_PAYOUT_SUBMIT_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
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
