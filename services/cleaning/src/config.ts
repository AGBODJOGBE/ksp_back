import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Configuration du service : variables communes, plus celles propres à cleaning. */
export const configSchema = baseServiceConfigSchema.safeExtend({
  /** Intervalle de la surveillance des passages impayés des particuliers (1 heure ; 0 : désactivée). */
  CLEANING_PAYMENT_WATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
});

export type ServiceConfig = z.infer<typeof configSchema>;
