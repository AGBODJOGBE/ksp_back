import { baseServiceConfigSchema, requireGrpcAddressesInProduction } from '@ksp/platform';
import { z } from 'zod';

/**
 * Configuration du service : variables communes, plus celles propres à cleaning. Les variables du
 * métier v2 (tâches planifiées, bornes) arrivent avec leur lot (ADR-054).
 */
export const configSchema = baseServiceConfigSchema
  .safeExtend({
    /** Adresse gRPC de file : photos et pièces des dossiers (FileInternalService, ADR-038). */
    FILE_GRPC_URL: z.string().min(1).default('localhost:50056'),
    /** Adresse gRPC d'identity : noms affichés au back-office (GetUsersByIds, GetOrganizationsByIds, ADR-029). */
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    /** Adresse gRPC de wallet : débits et remboursements du wallet du client (ADR-046). */
    WALLET_GRPC_URL: z.string().min(1).default('localhost:50057'),
    /**
     * Adresse gRPC du service geo (ADR-045, ADR-059) : commune par contour, adresse lisible, temps
     * de trajet. Plus de repli sur un appel direct à Nominatim ou Google.
     */
    GEO_GRPC_URL: z.string().min(1).default('localhost:50059'),
    /** Délai d'un fournisseur de géocodage chez geo (3 secondes) : l'appel à geo dure au plus 2 × ce délai + 1 s. */
    GEOCODING_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(3_000),
    /** Délai d'un calcul de trajets chez geo (DistanceMatrix, R-ZN-02) ; au-delà, trajet par défaut. */
    TRAVEL_TIME_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(2_000),
    /**
     * Clé de chiffrement des données personnelles (partie 16.3) : 32 octets en base64, du coffre à
     * secrets. Obligatoire en production ; ailleurs, clé temporaire si absente.
     */
    CLEANING_FIELD_ENCRYPTION_KEY: z.string().optional(),
    // --- Lot C ---
    /** Adresse gRPC de payment : paiement direct par Mobile Money (CreatePaymentRequest, R-WL-05). */
    PAYMENT_GRPC_URL: z.string().min(1).default('localhost:50055'),
    /**
     * Intervalle de la tâche des échéances du dossier (RV-13) : frais impayés, devis expirés, rappels,
     * visites des demandes closes, opérations du wallet en cours. 0 : tâche désactivée.
     */
    CLEANING_DEADLINES_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(600_000),
    // Lot E : paiement par séance et tâches planifiées.
    /** Adresse gRPC de billing : facture de séance (InvoiceIssuanceService.IssueInvoice, R-PP-06). */
    BILLING_GRPC_URL: z.string().min(1).default('localhost:50054'),
    /**
     * Intervalle des tâches du lot E (retards, couverture, rappels, factures, reprise des débits),
     * en millisecondes ; 0 : tâches désactivées.
     */
    CLEANING_EXECUTION_TASKS_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  })
  .refine(
    (cfg) =>
      cfg.NODE_ENV !== 'production' ||
      (Boolean(cfg.IDENTITY_TOKEN_URL) && Boolean(cfg.SERVICE_CLIENT_SECRET)),
    {
      message:
        'IDENTITY_TOKEN_URL et SERVICE_CLIENT_SECRET sont obligatoires en production : cleaning appelle identity, wallet, file et geo avec son jeton de service (ADR-022).',
      path: ['SERVICE_CLIENT_SECRET'],
    },
  )
  // Adresses gRPC des services appelés : jamais localhost en production (ADR-051).
  .superRefine(requireGrpcAddressesInProduction);

export type ServiceConfig = z.infer<typeof configSchema>;
