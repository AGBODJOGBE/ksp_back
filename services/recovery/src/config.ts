import {
  baseServiceConfigSchema,
  fieldKeyringEnv,
  refuseDevelopmentSecrets,
  requireFieldKeysInProduction,
  requireGrpcAddressesInProduction,
  sharesKeyMaterial,
} from '@ksp/platform';
import { z } from 'zod';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);

/**
 * Secrets de développement du .env.example : connus de tous, refusés en production (ADR-050). Le
 * test de configuration vérifie qu'ils restent ceux du fichier.
 */
export const DEV_SECRETS = {
  RECOVERY_DEBTOR_CODE_HMAC_SECRET: 'dev-only-recovery-debtor-code-hmac-secret-0123456789',
} as const;

/**
 * Configuration du service : variables communes, plus celles propres à recovery (ADR-060 à 063).
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Adresses gRPC des services appelés (ADR-060). */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    NOTIFICATION_GRPC_URL: z.string().min(1).default('localhost:50052'),
    PAYMENT_GRPC_URL: z.string().min(1).default('localhost:50055'),
    FILE_GRPC_URL: z.string().min(1).default('localhost:50056'),
    WALLET_GRPC_URL: z.string().min(1).default('localhost:50057'),
    DOCUMENT_GRPC_URL: z.string().min(1).default('localhost:50058'),
    /**
     * Trousseau de chiffrement des coordonnées des débiteurs (FieldCipher, ADR-063) : « clé » ou
     * « id:clé,id:clé » en base64 (32 octets). Obligatoire en production, distinct de la clé des
     * empreintes ; hors production, une clé temporaire est tirée au démarrage (avertissement).
     */
    RECOVERY_PII_ENCRYPTION_KEYS: fieldKeyringEnv('RECOVERY_PII_ENCRYPTION_KEYS'),
    /** Trousseau des empreintes de recherche du téléphone et de l'e-mail (BlindIndex, ADR-063). */
    RECOVERY_BLIND_INDEX_KEYS: fieldKeyringEnv('RECOVERY_BLIND_INDEX_KEYS'),
    /** Adresse du portail : liens « Mon espace ». */
    PORTAL_BASE_URL: z.preprocess(unset, z.url().default('http://localhost:3010')),
    /**
     * Page du portail qui ouvre le lien personnel du débiteur : `<adresse>/<jeton>` (ADR-061 ; chemin
     * à fixer avec le front, « /recouvrement » proposé). HTTPS en production : le jeton est dans
     * l'adresse.
     */
    RECOVERY_DEBTOR_BASE_URL: z.preprocess(unset, z.url().default('http://localhost:3010/recouvrement')),
    /**
     * Clé du HMAC des codes d'accès du débiteur (32 caractères au moins), fournie par le coffre en
     * production, jamais journalisée : sans elle, une fuite de la base ne révèle aucun code (ADR-061).
     */
    RECOVERY_DEBTOR_CODE_HMAC_SECRET: z.preprocess(
      unset,
      z.string().min(32).default(DEV_SECRETS.RECOVERY_DEBTOR_CODE_HMAC_SECRET),
    ),
    /** Échéance d'un appel gRPC ordinaire, en millisecondes. */
    RECOVERY_GRPC_DEADLINE_MS: z.coerce.number().int().min(500).max(30_000).default(3_000),
    /** Échéance de la production d'un PDF long (journal de preuve, ADR-060) : 15 secondes. */
    RECOVERY_LONG_DOCUMENT_DEADLINE_MS: z.coerce.number().int().min(3_000).max(60_000).default(15_000),
    /** Intervalle de la tâche des échéances des dossiers (R-SD-04, 4.4) : 10 minutes ; 0 : désactivée. */
    RECOVERY_CASE_DEADLINES_INTERVAL_MS: z.coerce.number().int().min(0).default(600_000),
  })
  .superRefine((cfg, ctx) => {
    requireFieldKeysInProduction(cfg, ctx, ['RECOVERY_PII_ENCRYPTION_KEYS', 'RECOVERY_BLIND_INDEX_KEYS']);
    const cipher = cfg.RECOVERY_PII_ENCRYPTION_KEYS?.trim();
    const index = cfg.RECOVERY_BLIND_INDEX_KEYS?.trim();
    if (cipher && index && sharesKeyMaterial(cipher, index)) {
      ctx.addIssue({
        code: 'custom',
        path: ['RECOVERY_BLIND_INDEX_KEYS'],
        message: 'La clé des empreintes doit être distincte de la clé de chiffrement (ADR-063).',
      });
    }
    refuseDevelopmentSecrets(cfg, ctx, DEV_SECRETS);
    if (cfg.NODE_ENV === 'production' && !cfg.RECOVERY_DEBTOR_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['RECOVERY_DEBTOR_BASE_URL'],
        message: 'Adresse HTTPS obligatoire en production : le lien du débiteur porte son jeton (ADR-061).',
      });
    }
    if (cfg.NODE_ENV === 'production' && (!cfg.IDENTITY_TOKEN_URL || !cfg.SERVICE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SERVICE_CLIENT_SECRET'],
        message:
          'IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : recovery appelle wallet, payment, document, file, notification et identity (ADR-022).',
      });
    }
  })
  // Adresses gRPC des services appelés : jamais localhost en production (ADR-051).
  .superRefine(requireGrpcAddressesInProduction);

export type ServiceConfig = z.infer<typeof configSchema>;
