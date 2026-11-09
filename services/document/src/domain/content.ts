/**
 * Contenu d'un document, indépendant de la bibliothèque PDF : une suite de blocs que l'adaptateur
 * de rendu met en page (en-tête KSP, numéro, date, pied de page). Les modèles ne produisent que ces
 * blocs : ils restent testables sans PDF, et le rendu peut changer sans toucher aux textes.
 */
export type Block =
  /** Titre de section. */
  | { kind: 'heading'; text: string }
  /** Paragraphe justifié ; `strong` : en gras (mention importante). */
  | { kind: 'paragraph'; text: string; strong?: boolean }
  /** Liste à puces. */
  | { kind: 'list'; items: readonly string[] }
  /** Libellés et valeurs sur deux colonnes (parties, créance…). */
  | { kind: 'fields'; rows: readonly (readonly [string, string])[] }
  /** Tableau simple ; la dernière ligne peut être un total (`totalRow`). */
  | {
      kind: 'table';
      columns: readonly string[];
      rows: readonly (readonly string[])[];
      /** Alignement de chaque colonne (gauche par défaut). */
      align?: readonly ('left' | 'right')[];
      totalRow?: readonly string[];
    }
  /** Emplacements de signature : une colonne par partie (mention, nom). */
  | { kind: 'signatures'; parties: readonly { role: string; name: string; note: string }[] };

export interface DocumentContent {
  /** Titre principal, en tête de la première page. */
  title: string;
  /** Numéro lisible du document (MAN-2026-000042). */
  number: string;
  /** Ligne « Fait à Cotonou, le 9 novembre 2026 ». */
  dateLine: string;
  blocks: readonly Block[];
}

/** Émetteur imprimé dans l'en-tête et le pied de page (configuration du service). */
export interface Issuer {
  name: string;
  address: string;
  /** Mentions légales (RCCM, IFU…) ; vide si non renseignées. */
  legalDetails: string;
}
