import { baseServiceConfigSchema } from '@ksp/platform';
import { type z } from 'zod';

/**
 * Configuration du service : variables communes, plus celles propres à cleaning.
 * Pour en ajouter : baseServiceConfigSchema.safeExtend({ MA_VARIABLE: z.string() }).
 */
export const configSchema = baseServiceConfigSchema;

export type ServiceConfig = z.infer<typeof configSchema>;
