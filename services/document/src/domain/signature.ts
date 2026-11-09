import { stripControlCharacters } from './text';

/**
 * Demande de signature par code à usage unique (ADR-044) : un signataire par document, identifié
 * par son compte ou, sans compte, par son téléphone et le lien de signature reçu.
 */
export type SignatureStatus = 'pending' | 'signed' | 'expired' | 'cancelled';
export type CodeChannel = 'whatsapp' | 'email' | 'sms';

export interface SignatureRequestRecord {
  id: string;
  documentId: string;
  status: SignatureStatus;
  signerUserId: string | null;
  /**
   * Coordonnées en clair, nécessaires pour envoyer les codes : gardées seulement tant que la demande
   * est en attente, effacées dès qu'elle est close (signée, expirée, annulée).
   */
  signerPhoneE164: string | null;
  signerEmail: string | null;
  /** Forme masquée, seule conservée après la clôture. */
  signerPhoneMasked: string;
  signerName: string;
  /** Empreinte SHA-256 du jeton du lien de signature ; null pour un signataire connecté. */
  tokenHash: string | null;
  /** Empreinte du PDF à signer, fixée à la demande. */
  documentSha256: string;
  idempotencyKey: string;
  createdAt: Date;
  expiresAt: Date;
  signedAt: Date | null;
  closedAt: Date | null;
}

export interface SignatureCode {
  id: string;
  requestId: string;
  /** HMAC du code, lié à son identifiant : le code n'est jamais conservé. */
  codeHash: string;
  channel: CodeChannel;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
}

/** Preuve de la signature, immuable. */
export interface SignatureEvidence {
  id: string;
  requestId: string;
  documentId: string;
  signedAt: Date;
  method: 'one_time_code';
  channel: CodeChannel;
  codeId: string;
  signerUserId: string | null;
  signerName: string;
  signerPhoneMasked: string;
  /** Adresse IP et navigateur tels que transmis par la gateway ; null s'ils manquent. */
  ip: string | null;
  userAgent: string | null;
  documentSha256: string;
  signedFileId: string;
  signedSha256: string;
  /** Le signataire a coché « J'ai lu le document et j'en accepte le contenu ». */
  consent: true;
  /** Version de la page de certificat. */
  certificateVersion: number;
}

/** Statut réel : une demande en attente au-delà de son expiration est expirée. */
export function effectiveStatus(request: SignatureRequestRecord, now: Date): SignatureStatus {
  return request.status === 'pending' && request.expiresAt.getTime() <= now.getTime()
    ? 'expired'
    : request.status;
}

/** Durée de validité d'une demande, en heures (7 jours par défaut, 30 jours au plus). */
export const DEFAULT_REQUEST_HOURS = 168;
export const MAX_REQUEST_HOURS = 720;

/** Navigateur conservé dans la preuve : tronqué, sans caractère de contrôle. */
export function cleanUserAgent(value: string | undefined): string | null {
  const cleaned = stripControlCharacters(value ?? '').trim();
  return cleaned ? cleaned.slice(0, 300) : null;
}

/** Adresse IP conservée dans la preuve : forme IPv4 ou IPv6 plausible, sinon null. */
export function cleanIp(value: string | undefined): string | null {
  const ip = (value ?? '').trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null;
}
