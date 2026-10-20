import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Une variable vide (`X=` dans un fichier .env) vaut une variable absente. */
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

/**
 * Configuration du service : variables communes, plus celles propres à notification.
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
  );

export type ServiceConfig = z.infer<typeof configSchema>;

export type WhatsAppProviderKind = 'meta' | 'console';

/** Prestataire WhatsApp retenu : celui demandé, sinon `meta` en production et `console` ailleurs. */
export function whatsappProviderKind(config: {
  NODE_ENV: string;
  NOTIFICATION_WHATSAPP_PROVIDER?: WhatsAppProviderKind | undefined;
}): WhatsAppProviderKind {
  return config.NOTIFICATION_WHATSAPP_PROVIDER ?? (config.NODE_ENV === 'production' ? 'meta' : 'console');
}
