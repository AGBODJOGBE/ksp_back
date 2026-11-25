/**
 * Fichiers et documents servis au débiteur sans compte (ADR-061) : ses pièces passent par file sous la
 * finalité `recovery_debtor_evidence`, déclarée par recovery pour lui et rattachée au dossier dès la
 * déclaration ; les adresses de lecture, de courte durée, viennent de file (pièces) ou de document
 * (reçus, attestation, échéancier signé). Ces adresses sont des secrets : jamais journalisées.
 */

export interface UploadSlot {
  fileId: string;
  url: string;
  expiresAt: string;
  headers: Record<string, string>;
}

export interface DebtorUploads {
  /** Fichier déclaré pour le débiteur, rattaché au dossier ; adresse d'envoi présignée. */
  create(input: {
    caseId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<UploadSlot>;
  /**
   * Contenu vérifié par file : `available`, ou `rejected` (taille, type, logiciel malveillant). Rend
   * aussi l'objet du fichier, pour vérifier qu'il appartient bien au dossier.
   */
  complete(fileId: string): Promise<{
    fileId: string;
    status: 'available' | 'rejected' | 'pending';
    fileName: string;
    subject: { type: string; id: string } | null;
  }>;
  /** Adresse de lecture d'un fichier rattaché au dossier. */
  readUrl(input: { fileId: string; caseId: string }): Promise<{ url: string; expiresAt: string }>;
}

export interface DocumentUrls {
  /** Adresse de lecture d'un document produit (version signée s'il l'est). */
  readUrl(documentId: string): Promise<{ url: string; expiresAt: string }>;
}
