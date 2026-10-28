import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Booléen d'environnement : « true » ou « false » (zod coerce.boolean prendrait « false » pour vrai). */
const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

/** Configuration du service : variables communes, plus celles propres à cleaning. */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Intervalle de la surveillance des passages impayés des particuliers (1 heure ; 0 : désactivée). */
    CLEANING_PAYMENT_WATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
    /** Adresse gRPC d'identity : noms affichés au back-office (GetUsersByIds, GetOrganizationsByIds, ADR-029). */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    /** Fuseau des contrôles de dates du terrain (Bénin). */
    CLEANING_TIME_ZONE: z
      .string()
      .min(1)
      .default('Africa/Porto-Novo')
      .refine(isTimeZone, { message: 'Fuseau horaire IANA inconnu.' }),
    /** Refuser de démarrer un passage avant le jour prévu (proposition à valider). */
    CLEANING_BLOCK_EARLY_INTERVENTION_START: flag(true),
    /** Refuser le compte rendu d'une visite avant l'heure prévue (proposition à valider). */
    CLEANING_BLOCK_EARLY_VISIT_REPORT: flag(true),
  })
  .refine(
    (cfg) =>
      cfg.NODE_ENV !== 'production' ||
      (Boolean(cfg.IDENTITY_TOKEN_URL) && Boolean(cfg.SERVICE_CLIENT_SECRET)),
    {
      message:
        'IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : cleaning lit les noms affichés au back-office dans identity (ADR-022, ADR-029).',
      path: ['SERVICE_CLIENT_SECRET'],
    },
  );

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type ServiceConfig = z.infer<typeof configSchema>;
