import { z } from 'zod';

/** Code de signature reçu par WhatsApp ou e-mail : 6 chiffres (ADR-044). */
const sign = z.strictObject({
  code: z.string().regex(/^[0-9]{6}$/),
  // Case « J'ai lu le document et j'en accepte le contenu » : document refuse false.
  consent: z.boolean(),
});

/**
 * Corps des routes de signature des documents (ADR-044), repris du contrat OpenAPI : tout champ
 * inconnu est refusé. document revérifie le code, le consentement et l'état de la demande.
 */
export const documentBodies = {
  signDocument: sign,
  signWithLink: sign,
};

/** Jeton d'un lien de signature : base64url ; un jeton mal formé est refusé sans appeler document. */
export const SIGNING_TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
