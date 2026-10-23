import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Configuration du service : variables communes, plus celles propres à billing. */
export const configSchema = baseServiceConfigSchema.safeExtend({
  /** Intervalle de la facturation planifiée (émission, échéances) : 15 minutes ; 0 : désactivée. */
  BILLING_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(0).default(900_000),
});

export type ServiceConfig = z.infer<typeof configSchema>;
