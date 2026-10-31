import { baseServiceConfigSchema } from '@ksp/platform';
import { z } from 'zod';

/** Variable vide (ligne « NOM= » d'un fichier .env) : considérée comme absente. */
const unset = (value: unknown) => (value === '' ? undefined : value);
const optionalText = z.preprocess(unset, z.string().min(1).optional());

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
    /** Adresse de l'API FedaPay ; par défaut celle de l'environnement. */
    FEDAPAY_API_URL: z.preprocess(unset, z.url().optional()),
    /**
     * Identifiant FedaPay de la devise XOF (`currency_id`), à relever dans le compte de test : sans
     * lui, seule la devise ISO de la réponse établit le XOF (jamais de XOF par défaut, ADR-031).
     */
    FEDAPAY_XOF_CURRENCY_ID: optionalText,
    /** Clé secrète FedaPay (sk_sandbox_… ou sk_live_…). */
    FEDAPAY_SECRET_KEY: optionalText,
    /** Secret de signature du webhook FedaPay. */
    FEDAPAY_WEBHOOK_SECRET: optionalText,
    /** Page du portail où le client revient après le paiement : <adresse>/<id du paiement>. */
    PAYMENT_RETURN_URL: z.url().default('http://localhost:3010/mon-espace/paiements'),
    /** Prestataire simulé : page du portail qui joue la page de paiement (?paymentId=…). */
    PAYMENT_SIMULATION_CHECKOUT_URL: z.url().default('http://localhost:3010/mon-espace/paiements/simulation'),
    /** Délai après lequel un paiement encore en attente expire (30 minutes). */
    PAYMENT_INTENT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    /** Intervalle minimal entre deux relectures d'un même paiement chez le prestataire. */
    PAYMENT_RECHECK_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(10),
    /** Fenêtre de réussite tardive : paiements non aboutis encore relus pendant 24 heures. */
    PAYMENT_LATE_SUCCESS_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    /** Intervalle entre deux relectures d'un paiement non abouti (réussite tardive), en minutes. */
    PAYMENT_LATE_SUCCESS_RECHECK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /** Rapprochement planifié des paiements en attente (2 minutes) ; 0 : désactivé. */
    PAYMENT_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(120_000),
    /** Adresses gRPC de cleaning et billing (montants dus). */
    CLEANING_GRPC_URL: z.string().min(1).default('localhost:50053'),
    BILLING_GRPC_URL: z.string().min(1).default('localhost:50054'),
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
    if (cfg.NODE_ENV !== 'production') return;
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
  });

export type ServiceConfig = z.infer<typeof configSchema>;

/** Simulation autorisée : prestataire simulé, hors production. */
export function simulationEnabled(config: ServiceConfig): boolean {
  return config.PAYMENT_PROVIDER === 'simulated' && config.NODE_ENV !== 'production';
}
