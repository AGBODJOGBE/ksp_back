import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);
const optionalUrl = z.preprocess(unset, z.url().optional());
const MB = 1024 * 1024;

/**
 * Configuration du service : variables communes, plus celles propres à file (ADR-038). Les clés du
 * stockage viennent du coffre en production, jamais du dépôt ; elles ne sont jamais journalisées.
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Adresse du stockage compatible S3 vue par le service : MinIO en local. */
    FILE_STORAGE_ENDPOINT: z.url().default('http://localhost:9000'),
    /**
     * Adresse vue par les fronts, inscrite dans les adresses présignées (signées avec elle) ; par
     * défaut FILE_STORAGE_ENDPOINT. Utile quand le service joint le stockage par le réseau interne.
     */
    FILE_STORAGE_PUBLIC_ENDPOINT: optionalUrl,
    /** Région de signature (MinIO : us-east-1 ; Contabo : celle de l'offre, à valider). */
    FILE_STORAGE_REGION: z.string().min(1).default('us-east-1'),
    FILE_STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Nom de bucket S3 invalide.')
      .default('ksp-files'),
    FILE_STORAGE_ACCESS_KEY: z.string().min(1),
    FILE_STORAGE_SECRET_KEY: z.string().min(1),
    /** Adressage par chemin (https://hôte/bucket/clé) plutôt que par sous-domaine. */
    FILE_STORAGE_FORCE_PATH_STYLE: z.stringbool().default(true),
    /** Développement : crée le bucket au démarrage s'il n'existe pas. Interdit en production. */
    FILE_STORAGE_CREATE_BUCKET: z.stringbool().default(false),
    /** Validité d'une adresse d'envoi (15 minutes). */
    FILE_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /** Validité d'une adresse de lecture (5 minutes). */
    FILE_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /** Envoi non confirmé purgé après ce délai (24 heures). */
    FILE_PENDING_TTL_MINUTES: z.coerce.number().int().min(30).max(10_080).default(1440),
    /** Fichier disponible jamais rattaché à un objet purgé après ce délai (24 heures). */
    FILE_UNATTACHED_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    /** Délai de grâce entre la suppression par un service et l'effacement physique (7 jours). */
    FILE_ERASE_DELAY_HOURS: z.coerce.number().int().min(0).max(2160).default(168),
    /** Envois en attente simultanés par compte. */
    FILE_MAX_PENDING_PER_OWNER: z.coerce.number().int().min(1).max(1000).default(20),
    /** Volume déclaré par compte sur 24 heures glissantes, en Mo. */
    FILE_DAILY_UPLOAD_MB: z.coerce.number().int().min(1).max(100_000).default(500),
    /** Intervalle de la purge (10 minutes) ; 0 : désactivée. */
    FILE_PURGE_INTERVAL_MS: z.coerce.number().int().min(0).default(600_000),
  })
  .superRefine((cfg, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (cfg.FILE_PENDING_TTL_MINUTES * 60 <= cfg.FILE_UPLOAD_URL_TTL_SECONDS) {
      fail(
        'FILE_PENDING_TTL_MINUTES',
        'Doit dépasser la validité d’une adresse d’envoi : un envoi en cours ne doit pas être purgé.',
      );
    }
    if (cfg.NODE_ENV !== 'production') return;
    if (cfg.FILE_STORAGE_CREATE_BUCKET) {
      fail('FILE_STORAGE_CREATE_BUCKET', 'Interdit en production : le bucket est créé par l’exploitation.');
    }
    const publicEndpoint = cfg.FILE_STORAGE_PUBLIC_ENDPOINT ?? cfg.FILE_STORAGE_ENDPOINT;
    if (!publicEndpoint.startsWith('https://')) {
      fail('FILE_STORAGE_PUBLIC_ENDPOINT', 'Adresse HTTPS obligatoire en production (adresses présignées).');
    }
  });

export type ServiceConfig = z.infer<typeof configSchema>;

export function dailyBytesPerOwner(config: ServiceConfig): number {
  return config.FILE_DAILY_UPLOAD_MB * MB;
}
