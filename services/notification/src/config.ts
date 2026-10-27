import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Une variable vide (`X=` dans un fichier .env) vaut une variable absente. */
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

/**
 * Configuration du service : variables communes, plus celles propres à notification.
 *
 * Prestataire e-mail (ADR-024) : `brevo` (obligatoire en production) ou `console` (développement,
 * refusé en production), sur le même modèle que WhatsApp.
 *
 * Prestataire WhatsApp (ADR-021) :
 * - `meta` : WhatsApp Cloud API de Meta, obligatoire en production ;
 * - `console` : le code est écrit dans le terminal, pour se connecter en développement sans téléphone.
 *   Le service refuse de démarrer avec `console` en production.
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** `meta` ou `console` ; par défaut `console` hors production, `meta` en production. */
    NOTIFICATION_WHATSAPP_PROVIDER: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['meta', 'console']).optional(),
    ),
    /** Jeton permanent de l'utilisateur système Meta (coffre à secrets). Jamais journalisé. */
    WHATSAPP_ACCESS_TOKEN: optionalText,
    /** Identifiant du numéro WhatsApp Business de KSP (coffre à secrets). */
    WHATSAPP_PHONE_NUMBER_ID: optionalText,
    /** Version de l'API Graph, par exemple v23.0. */
    WHATSAPP_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, 'WHATSAPP_API_VERSION attendu sous la forme v23.0.')
      .default('v23.0'),
    /** Modèle d'authentification « Copier le code » approuvé par Meta. */
    WHATSAPP_OTP_TEMPLATE: z.string().min(1).default('ksp_otp'),
    /** Langue du modèle approuvé. */
    WHATSAPP_TEMPLATE_LANGUAGE: z.string().min(1).default('fr'),
    /** Délai maximum d'un appel à Meta : identity attend notification 3 secondes au plus. */
    WHATSAPP_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

    /** `brevo` ou `console` ; par défaut `console` hors production, `brevo` en production (ADR-024). */
    NOTIFICATION_EMAIL_PROVIDER: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['brevo', 'console']).optional(),
    ),
    /** Clé d'API Brevo (coffre à secrets). Jamais journalisée. */
    BREVO_API_KEY: optionalText,
    /** Adresse d'expédition, sur un domaine vérifié chez Brevo (SPF, DKIM). */
    EMAIL_SENDER_ADDRESS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.email('EMAIL_SENDER_ADDRESS doit être une adresse e-mail.').optional(),
    ),
    EMAIL_SENDER_NAME: z.string().min(1).default('Groupe KSP'),
    /** Délai maximum d'un appel à Brevo (les e-mails partent des événements, sans appelant qui attend). */
    EMAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    /** Adresse gRPC d'identity : coordonnées des destinataires des événements (GetUsersByIds). */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    /** Adresse de « Mon espace KSP », pour les liens des messages. */
    PORTAL_BASE_URL: z.url().default('https://ksp.bj'),
    /** Fuseau des dates écrites dans les messages. */
    NOTIFICATION_TIME_ZONE: z.string().min(1).default('Africa/Porto-Novo'),
    /**
     * Comptes de l'équipe Nettoyage (admin, superviseurs) prévenus quand un événement ne désigne
     * personne : reprise après impayés, reprogrammation à finir à la main. Identifiants séparés par
     * des virgules ; vide par défaut (personne n'est prévenu).
     */
    NOTIFICATION_CLEANING_TEAM_USER_IDS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(
        z.array(z.uuid('NOTIFICATION_CLEANING_TEAM_USER_IDS : identifiants de comptes (UUID) attendus.')),
      ),
  })
  .refine((cfg) => !(cfg.NODE_ENV === 'production' && cfg.NOTIFICATION_WHATSAPP_PROVIDER === 'console'), {
    message:
      'NOTIFICATION_WHATSAPP_PROVIDER=console est interdit en production : les codes seraient écrits dans les journaux.',
    path: ['NOTIFICATION_WHATSAPP_PROVIDER'],
  })
  .refine(
    (cfg) =>
      whatsappProviderKind(cfg) !== 'meta' ||
      (Boolean(cfg.WHATSAPP_ACCESS_TOKEN) && Boolean(cfg.WHATSAPP_PHONE_NUMBER_ID)),
    {
      message:
        'WHATSAPP_ACCESS_TOKEN et WHATSAPP_PHONE_NUMBER_ID sont obligatoires avec le prestataire meta.',
      path: ['WHATSAPP_ACCESS_TOKEN'],
    },
  )

  .refine(
    (cfg) =>
      cfg.NODE_ENV !== 'production' ||
      (Boolean(cfg.IDENTITY_TOKEN_URL) && Boolean(cfg.SERVICE_CLIENT_SECRET)),
    {
      message:
        'IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : notification lit les destinataires dans identity (ADR-022).',
      path: ['SERVICE_CLIENT_SECRET'],
    },
  )
  .refine((cfg) => !(cfg.NODE_ENV === 'production' && cfg.NOTIFICATION_EMAIL_PROVIDER === 'console'), {
    message:
      'NOTIFICATION_EMAIL_PROVIDER=console est interdit en production : les e-mails seraient écrits dans les journaux.',
    path: ['NOTIFICATION_EMAIL_PROVIDER'],
  })
  .refine(
    (cfg) =>
      emailProviderKind(cfg) !== 'brevo' || (Boolean(cfg.BREVO_API_KEY) && Boolean(cfg.EMAIL_SENDER_ADDRESS)),
    {
      message: 'BREVO_API_KEY et EMAIL_SENDER_ADDRESS sont obligatoires avec le prestataire brevo.',
      path: ['BREVO_API_KEY'],
    },
  );

export type ServiceConfig = z.infer<typeof configSchema>;

export type EmailProviderKind = 'brevo' | 'console';

/** Prestataire e-mail retenu : celui demandé, sinon `brevo` en production et `console` ailleurs. */
export function emailProviderKind(config: {
  NODE_ENV: string;
  NOTIFICATION_EMAIL_PROVIDER?: EmailProviderKind | undefined;
}): EmailProviderKind {
  return config.NOTIFICATION_EMAIL_PROVIDER ?? (config.NODE_ENV === 'production' ? 'brevo' : 'console');
}

export type WhatsAppProviderKind = 'meta' | 'console';

/** Prestataire WhatsApp retenu : celui demandé, sinon `meta` en production et `console` ailleurs. */
export function whatsappProviderKind(config: {
  NODE_ENV: string;
  NOTIFICATION_WHATSAPP_PROVIDER?: WhatsAppProviderKind | undefined;
}): WhatsAppProviderKind {
  return config.NOTIFICATION_WHATSAPP_PROVIDER ?? (config.NODE_ENV === 'production' ? 'meta' : 'console');
}
