/**
 * Finalités des fichiers (ADR-038) : liste fermée, extensible par ajout. Chaque finalité fixe les
 * types acceptés, la taille maximale, qui envoie le contenu, les services qui en sont responsables
 * et le sort de ses fichiers à la suppression d'un compte (ADR-036).
 */
export const CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

const MB = 1024 * 1024;
const IMAGES: readonly ContentType[] = ['image/jpeg', 'image/png', 'image/webp'];

export interface PurposePolicy {
  contentTypes: readonly ContentType[];
  maxBytes: number;
  /**
   * `user` : envoyé par un compte connecté (via la gateway), puis rattaché par un service ;
   * `service` : produit et envoyé par un service, rattaché dès sa déclaration.
   */
  uploadedBy: 'user' | 'service';
  /** Services responsables : seuls à rattacher, lire pour autrui et supprimer ces fichiers. */
  services: readonly string[];
  /**
   * Compte supprimé (`identity.user.deleted`) : `erase` efface ses fichiers ; `keep` les garde,
   * détachés du compte (pièce justificative, preuve de prestation, document comptable) : leur sort
   * relève du service responsable, qui les supprime selon ses propres règles de conservation.
   */
  onAccountDeleted: 'erase' | 'keep';
}

export const PURPOSES = {
  /** Pièces justificatives d'un dossier de recouvrement : preuves d'une créance, conservées. */
  recovery_evidence: {
    contentTypes: ['application/pdf', ...IMAGES],
    maxBytes: 10 * MB,
    uploadedBy: 'user',
    services: ['recovery'],
    onAccountDeleted: 'keep',
  },
  /** Photos d'un passage du Nettoyage (avant, après) : preuve de la prestation pour le client. */
  cleaning_intervention_photo: {
    contentTypes: IMAGES,
    maxBytes: 8 * MB,
    uploadedBy: 'user',
    services: ['cleaning'],
    onAccountDeleted: 'keep',
  },
  /** Documents PDF produits par le service document (factures, devis, contrats). */
  generated_document: {
    contentTypes: ['application/pdf'],
    maxBytes: 20 * MB,
    uploadedBy: 'service',
    services: ['document'],
    onAccountDeleted: 'keep',
  },
  /** Photo de profil : donnée personnelle sans obligation de conservation. */
  avatar: {
    contentTypes: IMAGES,
    maxBytes: 2 * MB,
    uploadedBy: 'user',
    services: ['identity'],
    onAccountDeleted: 'erase',
  },
} as const satisfies Record<string, PurposePolicy>;

export type Purpose = keyof typeof PURPOSES;
export const PURPOSE_NAMES = Object.keys(PURPOSES) as Purpose[];

export function isPurpose(value: string): value is Purpose {
  return Object.prototype.hasOwnProperty.call(PURPOSES, value);
}

export function policyOf(purpose: Purpose): PurposePolicy {
  return PURPOSES[purpose];
}

/** Finalités dont un service est responsable. */
export function purposesOfService(service: string): Purpose[] {
  return PURPOSE_NAMES.filter((purpose) => policyOf(purpose).services.includes(service));
}

/** Finalités dont les fichiers sont effacés à la suppression du compte qui les a envoyés. */
export const ERASED_WITH_ACCOUNT: readonly Purpose[] = PURPOSE_NAMES.filter(
  (purpose) => policyOf(purpose).onAccountDeleted === 'erase',
);
