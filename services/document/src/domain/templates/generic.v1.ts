import { z } from 'zod';
import { type DocumentTemplate, line, place, text } from './template';

/**
 * Modèle de test, version 1 : titre et paragraphes libres, signature possible. Sert aux essais du
 * rendu et de la signature ; désactivé en production (configuration du service, ADR-044).
 */
const schema = z.strictObject({
  title: line(150),
  paragraphs: z.array(text(3000)).min(1).max(50),
  /** Nom de la personne appelée à signer, imprimé dans l'emplacement de signature. */
  signerName: line(200).optional(),
  place,
});

export type GenericV1 = z.infer<typeof schema>;

export const genericV1: DocumentTemplate<GenericV1> = {
  code: 'generic',
  version: 1,
  numberPrefix: 'DOC',
  signature: 'optional',
  services: [],
  schema,
  title: (v) => v.title,
  place: (v) => v.place,
  build: (v) => [
    ...v.paragraphs.map((paragraph) => ({ kind: 'paragraph' as const, text: paragraph })),
    ...(v.signerName
      ? [
          {
            kind: 'signatures' as const,
            parties: [{ role: 'Le signataire', name: v.signerName, note: 'Signature électronique' }],
          },
        ]
      : []),
  ],
};
