import { z } from 'zod';

/**
 * Corps des routes du stockage des fichiers (ADR-038), repris du contrat OpenAPI : tout champ
 * inconnu est refusé. file revérifie la finalité, le type et la taille de chaque finalité.
 */
export const fileBodies = {
  createFileUpload: z.strictObject({
    purpose: z.enum(['recovery_evidence', 'cleaning_intervention_photo', 'generated_document', 'avatar']),
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(3).max(100),
    sizeBytes: z
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
  }),
};
