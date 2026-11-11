import { baseServiceConfigSchema, requireGrpcAddressesInProduction } from '@ksp/platform';
import { z } from 'zod';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);
const optionalText = z.preprocess(unset, z.string().min(1).optional());
/** Liste de noms de services séparés par des virgules (« recovery,realestate »). */
const serviceList = (fallback: string) =>
  z
    .preprocess(unset, z.string().default(fallback))
    .transform((value) =>
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1));

/** Secret de développement des jetons de lien : refusé en production. */
export const DEV_LINK_TOKEN_SECRET = 'ksp-dev-payment-link-secret-not-for-production';

/** Préfixe des clés secrètes FedaPay selon l'environnement. */
const FEDAPAY_KEY_PREFIX = { sandbox: 'sk_sandbox_', live: 'sk_live_' } as const;

/** Adresse HTTPS d'un hôte de FedaPay (fedapay.com ou un sous-domaine). */
function isFedapayHost(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === 'https:' && (url.hostname === 'fedapay.com' || url.hostname.endsWith('.fedapay.com'))
  );
}

/**
 * Configuration du service : variables communes, plus celles propres à payment (ADR-031).
 * Les secrets FedaPay viennent du coffre, jamais du dépôt ; ils ne sont jamais journalisés.
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Prestataire : `fedapay`, ou `simulated` pour le développement local (interdit en production). */
    PAYMENT_PROVIDER: z.enum(['fedapay', 'simulated']).default('simulated'),
    /** Environnement FedaPay : `sandbox` (clés de test) ou `live`. */
    FEDAPAY_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
    /**
     * Adresse de l'API FedaPay ; par défaut celle de l'environnement. En production : seulement une
     * adresse HTTPS d'un hôte *.fedapay.com (ADR-048).
     */
    FEDAPAY_API_URL: z.preprocess(unset, z.url().optional()),
    /**
     * Identifiant FedaPay de la devise XOF (`currency_id`), à relever dans le compte de test : sans
     * lui, seule la devise ISO de la réponse établit le XOF (jamais de XOF par défaut, ADR-031).
     */
    FEDAPAY_XOF_CURRENCY_ID: optionalText,
    /** Clé secrète FedaPay : sk_sandbox_… en bac à sable, sk_live_… en live (contrôlé au démarrage). */
    FEDAPAY_SECRET_KEY: optionalText,
    /** Secret de signature du webhook FedaPay. */
    FEDAPAY_WEBHOOK_SECRET: optionalText,
    /** Page du portail où le client revient après le paiement : <adresse>/<id du paiement>. */
    PAYMENT_RETURN_URL: z.url().default('http://localhost:3010/mon-espace/paiements'),
    /** Prestataire simulé : page du portail qui joue la page de paiement (?paymentId=…). */
    PAYMENT_SIMULATION_CHECKOUT_URL: z.url().default('http://localhost:3010/mon-espace/paiements/simulation'),
    /**
     * Délai après lequel un paiement encore en attente expire (30 minutes), si le prestataire sait
     * annuler sa page ; sinon PAYMENT_CHECKOUT_VALIDITY_MINUTES (ADR-048).
     */
    PAYMENT_INTENT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    /**
     * Validité d'une page du prestataire qui ne sait pas l'annuler (FedaPay : non documentée, 24 h
     * par défaut, à valider avec le compte) : le paiement reste en attente et sa page réutilisée
     * jusque-là ; aucune autre page n'est ouverte pour le même objet (ADR-048).
     */
    PAYMENT_CHECKOUT_VALIDITY_MINUTES: z.coerce.number().int().min(5).max(43_200).default(1440),
    /** Intervalle minimal entre deux relectures d'un même paiement chez le prestataire. */
    PAYMENT_RECHECK_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(10),
    /** Fenêtre de réussite tardive : paiements non aboutis encore relus pendant 24 heures. */
    PAYMENT_LATE_SUCCESS_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    /** Intervalle entre deux relectures d'un paiement non abouti (réussite tardive), en minutes. */
    PAYMENT_LATE_SUCCESS_RECHECK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /**
     * Paiement réussi pas encore enregistré par cleaning ou billing : un nouveau paiement est refusé
     * avec « réessayez » pendant ce délai (minutes), puis avec « contactez le support » (ADR-032).
     */
    PAYMENT_UNRECORDED_GRACE_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /** Rapprochement planifié des paiements en attente (2 minutes) ; 0 : désactivé. */
    PAYMENT_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(120_000),
    /** Page publique d'un lien de paiement (portail) : <adresse>/<jeton> (ADR-040). */
    PAYMENT_LINK_BASE_URL: z.url().default('http://localhost:3010/payer'),
    /** Secret des jetons de lien (32 caractères au moins), fourni par le coffre ; jamais journalisé. */
    PAYMENT_LINK_TOKEN_SECRET: z.preprocess(unset, z.string().min(32).default(DEV_LINK_TOKEN_SECRET)),
    /** Services autorisés à créer des liens de paiement (jeton de service). */
    PAYMENT_LINK_ISSUERS: serviceList('recovery'),
    /** Essais de paiement acceptés par lien et par heure. */
    PAYMENT_LINK_ATTEMPTS_PER_HOUR: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * Exécution des reversements (ADR-041) : `manual` (la finance fait le virement et le confirme au
     * back-office), ou `fedapay` (API de reversement, à activer une fois validée avec le compte).
     */
    PAYOUT_PROVIDER: z.enum(['manual', 'fedapay']).default('manual'),
    /** Services autorisés à demander des reversements (jeton de service). */
    PAYMENT_PAYOUT_ISSUERS: serviceList('wallet'),
    /** Adresses gRPC de cleaning et billing (montants dus). */
    CLEANING_GRPC_URL: z.string().min(1).default('localhost:50053'),
    BILLING_GRPC_URL: z.string().min(1).default('localhost:50054'),
    /** Adresse gRPC d'identity (noms affichés au back-office, ADR-029). */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
  })
  .superRefine((cfg, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (cfg.PAYMENT_PROVIDER === 'fedapay') {
      if (!cfg.FEDAPAY_SECRET_KEY) fail('FEDAPAY_SECRET_KEY', 'Obligatoire avec PAYMENT_PROVIDER=fedapay.');
      if (!cfg.FEDAPAY_XOF_CURRENCY_ID) {
        fail(
          'FEDAPAY_XOF_CURRENCY_ID',
          'Obligatoire avec PAYMENT_PROVIDER=fedapay : identifiant FedaPay de la devise XOF (currency_id).',
        );
      }
      if (!cfg.FEDAPAY_WEBHOOK_SECRET) {
        fail(
          'FEDAPAY_WEBHOOK_SECRET',
          'Obligatoire avec PAYMENT_PROVIDER=fedapay : signature des notifications.',
        );
      }
    }
    if (cfg.PAYOUT_PROVIDER === 'fedapay' && !cfg.FEDAPAY_SECRET_KEY) {
      fail('FEDAPAY_SECRET_KEY', 'Obligatoire avec PAYOUT_PROVIDER=fedapay.');
    }
    // Une réussite tardive doit rester relue au moins aussi longtemps qu'une page peut être payée.
    if (cfg.PAYMENT_LATE_SUCCESS_WINDOW_HOURS * 60 < cfg.PAYMENT_CHECKOUT_VALIDITY_MINUTES) {
      fail(
        'PAYMENT_LATE_SUCCESS_WINDOW_HOURS',
        'Fenêtre de réussite tardive au moins égale à PAYMENT_CHECKOUT_VALIDITY_MINUTES (ADR-048).',
      );
    }
    const usesFedapay = cfg.PAYMENT_PROVIDER === 'fedapay' || cfg.PAYOUT_PROVIDER === 'fedapay';
    // Clé et environnement concordants : jamais de clé réelle contre le bac à sable, ni l'inverse.
    const key = cfg.FEDAPAY_SECRET_KEY;
    if (usesFedapay && key && !key.startsWith(FEDAPAY_KEY_PREFIX[cfg.FEDAPAY_ENVIRONMENT])) {
      fail(
        'FEDAPAY_SECRET_KEY',
        `Clé ${FEDAPAY_KEY_PREFIX[cfg.FEDAPAY_ENVIRONMENT]}… attendue avec FEDAPAY_ENVIRONMENT=${cfg.FEDAPAY_ENVIRONMENT}.`,
      );
    }
    if (cfg.NODE_ENV !== 'production') return;
    if (usesFedapay) {
      // ADR-048 : jamais le bac à sable ni une adresse libre en production.
      if (cfg.FEDAPAY_ENVIRONMENT !== 'live') {
        fail('FEDAPAY_ENVIRONMENT', 'FEDAPAY_ENVIRONMENT=live obligatoire en production.');
      }
      if (cfg.FEDAPAY_API_URL && !isFedapayHost(cfg.FEDAPAY_API_URL)) {
        fail('FEDAPAY_API_URL', 'Adresse HTTPS d’un hôte *.fedapay.com obligatoire en production.');
      }
    }
    if (cfg.PAYMENT_LINK_TOKEN_SECRET === DEV_LINK_TOKEN_SECRET) {
      fail('PAYMENT_LINK_TOKEN_SECRET', 'Secret propre à la production obligatoire (coffre).');
    }
    if (!cfg.PAYMENT_LINK_BASE_URL.startsWith('https://')) {
      fail('PAYMENT_LINK_BASE_URL', 'Adresse HTTPS obligatoire en production.');
    }
    if (cfg.PAYMENT_PROVIDER !== 'fedapay') {
      fail('PAYMENT_PROVIDER', 'Le prestataire simulé est interdit en production.');
    }
    if (!cfg.IDENTITY_TOKEN_URL || !cfg.SERVICE_CLIENT_SECRET) {
      fail(
        'SERVICE_CLIENT_SECRET',
        'IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : payment lit les montants dus dans cleaning et billing (ADR-022).',
      );
    }
    if (!cfg.PAYMENT_RETURN_URL.startsWith('https://')) {
      fail('PAYMENT_RETURN_URL', 'Adresse HTTPS obligatoire en production.');
    }
  })
  // Adresses gRPC des services appelés : jamais localhost en production (ADR-051).
  .superRefine(requireGrpcAddressesInProduction);

export type ServiceConfig = z.infer<typeof configSchema>;

/** Simulation autorisée : prestataire simulé, hors production. */
export function simulationEnabled(config: ServiceConfig): boolean {
  return config.PAYMENT_PROVIDER === 'simulated' && config.NODE_ENV !== 'production';
}
