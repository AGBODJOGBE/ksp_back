import { baseServiceConfigSchema, requireGrpcAddressesInProduction } from '@ksp/platform';
import { z } from 'zod';

/** Booléen d'environnement : « true » ou « false » (zod coerce.boolean prendrait « false » pour vrai). */
const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);

/** Configuration du service : variables communes, plus celles propres à cleaning. */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Intervalle de la surveillance des passages impayés des particuliers (1 heure ; 0 : désactivée). */
    CLEANING_PAYMENT_WATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
    /** Intervalle de la purge des positions GPS (ADR-035) : 6 heures ; 0 : désactivée. */
    CLEANING_LOCATION_PURGE_INTERVAL_MS: z.coerce.number().int().min(0).default(21_600_000),
    /** Intervalle de la tâche des échéances des demandes (ADR-053) : 10 minutes ; 0 : désactivée. */
    CLEANING_REQUEST_DEADLINES_INTERVAL_MS: z.coerce.number().int().min(0).default(600_000),
    /** Adresse gRPC de file : photos des passages (FileInternalService, ADR-038, ADR-053). */
    FILE_GRPC_URL: z.string().min(1).default('localhost:50056'),
    /** Adresse gRPC d'identity : noms affichés au back-office (GetUsersByIds, GetOrganizationsByIds, ADR-029). */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    /** Adresse gRPC de wallet : paiement d'une mission par le portefeuille prépayé (ADR-046). */
    WALLET_GRPC_URL: z.string().min(1).default('localhost:50057'),
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
    /**
     * Adresse gRPC du service geo (ADR-045) : renseignée, le géocodage inverse passe par geo et
     * les deux variables suivantes ne servent plus. Vide : appel direct des fournisseurs (repli).
     */
    GEO_GRPC_URL: z.preprocess(unset, z.string().min(1).optional()),
    /**
     * Géocodage inverse (ADR-034), facultatif : Nominatim auto-hébergé d'abord, Google en secours.
     * Un fournisseur sans sa variable est désactivé ; sans aucun, le client choisit sa commune.
     */
    NOMINATIM_URL: z.preprocess(unset, z.url().optional()),
    /** Clé Google Maps Geocoding (coffre) ; jamais journalisée. */
    GOOGLE_MAPS_API_KEY: z.preprocess(unset, z.string().min(1).optional()),
    /** Délai maximal d'un appel de géocodage, par fournisseur (3 secondes). */
    GEOCODING_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(3_000),
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
  )
  // Adresses gRPC des services appelés : jamais localhost en production (ADR-051).
  .superRefine(requireGrpcAddressesInProduction);

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type ServiceConfig = z.infer<typeof configSchema>;
