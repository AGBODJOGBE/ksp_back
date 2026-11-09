import { z } from 'zod';
import { type Block, type Issuer } from '../content';
import { hasControlCharacter } from '../text';

/**
 * Modèle de document versionné (ADR-044). Chaque version est un fichier du dépôt : une version
 * publiée ne change plus (un document produit doit pouvoir être relu tel quel), toute évolution du
 * texte ou des variables devient une nouvelle version.
 */
export interface DocumentTemplate<V = unknown> {
  code: string;
  version: number;
  /** Préfixe du numéro lisible (MAN-2026-000042). */
  numberPrefix: string;
  /**
   * `required` : document fait pour être signé (mandat, protocole) ; `optional` : signature
   * possible ; `none` : jamais signé (mise en demeure).
   */
  signature: 'required' | 'optional' | 'none';
  /** Services métier autorisés à produire ce modèle ; vide : tout service (modèle de test). */
  services: readonly string[];
  /** Variables typées et validées : tout champ inconnu est refusé. */
  schema: z.ZodType<V>;
  title(variables: V): string;
  /** Blocs du document, après l'en-tête (titre, numéro, date) imprimé par le rendu. */
  build(variables: V, context: TemplateContext): Block[];
  /** Lieu de la ligne « Fait à … » (Cotonou par défaut). */
  place(variables: V): string;
}

export interface TemplateContext {
  number: string;
  issuedAt: Date;
  timeZone: string;
  issuer: Issuer;
}

/** Texte libre, sans caractère de contrôle (sauts de ligne admis). */
export const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacter(value, true), 'Caractère non imprimable.');

/** Texte d'une ligne. */
export const line = (max: number) => text(max).regex(/^[^\n]*$/, 'Une seule ligne attendue.');

/** Montant entier en XOF (FCFA), jamais de décimale. */
export const amount = z.int().min(1).max(100_000_000_000);

/** Date calendaire « AAAA-MM-JJ ». */
export const calendarDate = z.iso.date();

export const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'Numéro E.164 attendu.');

/** Référence d'un dossier : lettres, chiffres, « - », « _ », « / ». */
export const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_/-]{0,39}$/, 'Référence invalide.');

export const place = line(80).default('Cotonou');
