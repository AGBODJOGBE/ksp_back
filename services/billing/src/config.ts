import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Configuration du service : variables communes, plus celles propres à billing. */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Intervalle de la facturation planifiée (émission, échéances) : 15 minutes ; 0 : désactivée. */
    BILLING_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(0).default(900_000),
    /** Adresse gRPC d'identity : en-tête des factures d'organisation (GetOrganizationsByIds). */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
  })
  .refine(
    (cfg) =>
      cfg.NODE_ENV !== 'production' ||
      (Boolean(cfg.IDENTITY_TOKEN_URL) && Boolean(cfg.SERVICE_CLIENT_SECRET)),
    {
      message:
        "IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : billing lit l'en-tête des factures dans identity (ADR-022).",
      path: ['SERVICE_CLIENT_SECRET'],
    },
  );

export type ServiceConfig = z.infer<typeof configSchema>;
