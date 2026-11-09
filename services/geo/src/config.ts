import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);

/**
 * geo n'a ni base de données ni événements (ADR-045) : les variables communes DATABASE_URL et
 * RABBITMQ_URL sont sans objet. Le kit les exige ; elles reçoivent une valeur jamais utilisée (la
 * connexion RabbitMQ du kit n'est ouverte qu'au premier usage, et geo n'en fait aucun).
 */
const NOT_USED = 'non-utilise';
const withoutStorage = (env: unknown) => ({
  DATABASE_URL: NOT_USED,
  RABBITMQ_URL: NOT_USED,
  ...(env as Record<string, unknown>),
});

/** Configuration du service : variables communes, plus celles propres à geo (ADR-045). */
const geoConfigSchema = baseServiceConfigSchema.safeExtend({
  /**
   * Géocodage inverse (ADR-034) : Nominatim auto-hébergé d'abord, Google en secours. Un fournisseur
   * sans sa variable est désactivé ; sans aucun, ReverseGeocode ne trouve jamais de commune.
   */
  NOMINATIM_URL: z.preprocess(unset, z.url().optional()),
  /** Clé Google Maps Geocoding (coffre) ; jamais journalisée. */
  GOOGLE_MAPS_API_KEY: z.preprocess(unset, z.string().min(1).optional()),
  /** Délai maximal d'un appel de géocodage, par fournisseur (3 secondes). */
  GEOCODING_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(3_000),
  /** Durée de vie d'un résultat de géocodage en mémoire (1 heure ; 0 : pas de cache). */
  GEOCODING_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(3_600),
  /** Nombre maximal de résultats de géocodage gardés en mémoire. */
  GEOCODING_CACHE_MAX_ENTRIES: z.coerce.number().int().min(0).max(100_000).default(5_000),
  /** Adresse d'osrm-routed ; absente : routage indisponible (GEO_ROUTING_UNAVAILABLE). */
  OSRM_URL: z.preprocess(unset, z.url().optional()),
  /** Délai maximal d'un appel à OSRM (2 secondes). */
  OSRM_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
});

export const configSchema = z.preprocess(withoutStorage, geoConfigSchema);

export type ServiceConfig = z.infer<typeof configSchema>;
