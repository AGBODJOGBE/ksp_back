/**
 * Document produit à partir d'un modèle (ADR-044). Le PDF vit dans le service file ; la base de
 * document ne garde que ses métadonnées, son empreinte et, après signature, celles du PDF signé.
 * Les variables du modèle ne sont pas conservées (données personnelles) : le PDF fait foi.
 */
export type DocumentStatus = 'draft' | 'pending_signature' | 'signed' | 'expired' | 'cancelled';

export interface DocumentSubject {
  type: string;
  id: string;
}

export interface DocumentRecord {
  id: string;
  template: string;
  templateVersion: number;
  title: string;
  number: string;
  status: DocumentStatus;
  subject: DocumentSubject;
  /** Compte titulaire ; null s'il n'y en a pas ou s'il a été supprimé (ADR-036). */
  ownerId: string | null;
  /** Service métier qui a produit le document : seul à le gérer. */
  producerService: string;
  idempotencyKey: string;
  fileId: string;
  /** Empreinte SHA-256 (hexadécimale) du PDF produit. */
  sha256: string;
  sizeBytes: number;
  signedFileId: string | null;
  signedSha256: string | null;
  createdAt: Date;
  signedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
}

/** Un document se fait (de nouveau) signer tant qu'il n'est ni signé, ni annulé, ni en cours. */
export function canRequestSignature(status: DocumentStatus): boolean {
  return status === 'draft' || status === 'expired';
}

/** Un document signé ne s'annule plus : il est une preuve. */
export function canCancel(status: DocumentStatus): boolean {
  return status !== 'signed';
}

/** Identifiant d'objet métier : UUID ou référence courte. */
export const SUBJECT_TYPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
export const SUBJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Objet du service file auquel les PDF d'un document sont rattachés (ADR-038). */
export const FILE_SUBJECT_TYPE = 'document_file';

/** Numéro lisible : préfixe, année, séquence sur 6 chiffres (MAN-2026-000042). */
export function formatDocumentNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}

/** Nom du fichier PDF stocké : numéro du document, sans donnée personnelle. */
export function pdfFileName(number: string, signed: boolean): string {
  return `${number}${signed ? '-signe' : ''}.pdf`;
}
