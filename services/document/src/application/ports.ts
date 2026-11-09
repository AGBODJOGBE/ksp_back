import { type DocumentEventPayloads } from '@ksp/contracts';
import { type CodePolicy } from '../domain/code-policy';
import { type DocumentContent, type Issuer } from '../domain/content';
import { type DocumentRecord, type DocumentStatus } from '../domain/document';
import {
  type CodeChannel,
  type SignatureCode,
  type SignatureEvidence,
  type SignatureRequestRecord,
} from '../domain/signature';

export interface Clock {
  now(): Date;
}

/** Identifiants UUID v7 (triables par date de création). */
export interface IdGenerator {
  next(): string;
}

/** Effacement des liens d'un compte supprimé (ADR-036), idempotent par l'inbox. */
export interface AccountErasure {
  status: 'processed' | 'duplicate';
  /** Documents dont le compte était propriétaire : gardés, détachés. */
  detachedDocuments: number;
  /** Demandes de signature en attente adressées au compte : annulées. */
  cancelledRequests: number;
}

/** Fin de la signature, enregistrée en une transaction avec l'événement (outbox). */
export interface SignatureCompletion {
  requestId: string;
  documentId: string;
  codeId: string;
  signedAt: Date;
  signedFileId: string;
  signedSha256: string;
  evidence: SignatureEvidence;
  event: DocumentEventPayloads['document.signature.completed'];
}

/**
 * Base du service. Chaque changement d'état est conditionnel (état attendu dans la clause WHERE) :
 * deux requêtes simultanées ou plusieurs instances ne l'appliquent qu'une fois.
 */
export interface DocumentRepository {
  /** Séquence suivante du numéro lisible pour ce préfixe et cette année (sans trou en cas de succès). */
  nextNumber(prefix: string, year: number): Promise<number>;
  /** Enregistre un document ; false si la clé d'idempotence du service est déjà prise. */
  create(document: DocumentRecord): Promise<boolean>;
  findById(id: string): Promise<DocumentRecord | null>;
  findByIdempotencyKey(producerService: string, key: string): Promise<DocumentRecord | null>;

  findRequestById(id: string): Promise<SignatureRequestRecord | null>;
  findRequestByTokenHash(tokenHash: string): Promise<SignatureRequestRecord | null>;
  findRequestByIdempotencyKey(documentId: string, key: string): Promise<SignatureRequestRecord | null>;
  /** Demande la plus récente du document. */
  latestRequest(documentId: string): Promise<SignatureRequestRecord | null>;
  /** Le compte est-il (ou a-t-il été) signataire d'une demande du document ? */
  isSigner(documentId: string, userId: string): Promise<boolean>;
  /**
   * Ouvre une demande : le document passe à « pending_signature » s'il est encore dans l'un des
   * états attendus ; false sinon (rien n'est enregistré).
   */
  openRequest(request: SignatureRequestRecord, expected: readonly DocumentStatus[]): Promise<boolean>;
  /** Retire une demande qui n'a pu être annoncée au signataire ; le document revient à `restore`. */
  abortRequest(requestId: string, documentId: string, restore: DocumentStatus): Promise<void>;
  /** Annule un document non signé et sa demande en attente ; false s'il est signé entre-temps. */
  cancelDocument(id: string, input: { reason: string | null; now: Date }): Promise<boolean>;
  /** Clôt une demande expirée (et son document) ; coordonnées en clair effacées. */
  expireRequest(requestId: string, now: Date): Promise<boolean>;
  /** Demandes en attente dont l'expiration est passée : closes par lots. */
  expireDue(now: Date, limit: number): Promise<number>;

  /** Dates d'envoi des codes de la demande depuis `since`. */
  codeSentDates(requestId: string, since: Date): Promise<Date[]>;
  createCode(code: SignatureCode): Promise<void>;
  /** Canal effectivement utilisé, connu après l'envoi. */
  setCodeChannel(codeId: string, channel: CodeChannel): Promise<void>;
  /** Retire un code qui n'a pas pu être envoyé. */
  deleteCode(codeId: string): Promise<void>;
  /** Dernier code ni consommé, ni expiré, ni épuisé ; null sinon. */
  activeCode(requestId: string, now: Date, maxAttempts: number): Promise<SignatureCode | null>;
  /** Compte un essai faux ; renvoie le nombre d'essais du code. */
  recordFailedAttempt(codeId: string): Promise<number>;
  /**
   * Signature : code consommé, demande et document signés, preuve et événement enregistrés, en une
   * transaction. false si la demande n'est plus en attente ou le code déjà consommé.
   */
  completeSignature(completion: SignatureCompletion): Promise<boolean>;
  /**
   * Compte supprimé (`identity.user.deleted`), dans la même transaction que l'inbox : documents
   * détachés du propriétaire, demandes en attente adressées au compte annulées, identifiant du
   * compte retiré des demandes et des preuves (le nom et le téléphone masqués restent : preuve).
   */
  eraseAccount(
    userId: string,
    input: { eventId: string; consumer: string; now: Date },
  ): Promise<AccountErasure>;
}

/** Rendu PDF : mise en page des blocs, polices embarquées. */
export interface PdfRenderer {
  render(content: DocumentContent, meta: PdfMeta): Promise<Uint8Array>;
  pageCount(pdf: Uint8Array): Promise<number>;
  /** Ajoute la page de certificat après les pages d'origine, sans modifier celles-ci. */
  appendCertificate(original: Uint8Array, certificate: DocumentContent, meta: PdfMeta): Promise<Uint8Array>;
}

export interface PdfMeta {
  title: string;
  createdAt: Date;
}

/** Stockage des PDF par le service file (finalité generated_document, ADR-038). */
export interface PdfStore {
  /** Déclare, envoie et confirme le PDF, rattaché au document. */
  store(input: {
    documentId: string;
    fileName: string;
    bytes: Uint8Array;
    ownerId: string | null;
  }): Promise<{ fileId: string }>;
  /** Contenu stocké, relu pour vérifier son empreinte. */
  read(fileId: string, documentId: string): Promise<Uint8Array>;
  downloadUrl(fileId: string, documentId: string): Promise<{ url: string; expiresAt: Date }>;
  /** Suppression (au mieux) d'un fichier devenu inutile. */
  remove(fileId: string, documentId: string): Promise<void>;
}

/** Coordonnées d'un signataire pour l'envoi d'un message. */
export interface Contact {
  userId: string | null;
  phoneE164: string | null;
  email: string | null;
}

/** Envoi des messages de signature par notification (SendNotification, ADR-014). */
export interface SignatureNotifier {
  /** Code à usage unique ; renvoie le canal qui l'a acheminé. */
  sendCode(input: {
    codeId: string;
    contact: Contact;
    code: string;
    expiresInMinutes: number;
    documentTitle: string;
    ttlSeconds: number;
  }): Promise<{ channel: CodeChannel }>;
  /** Lien de signature (ou rappel dans l'espace KSP pour un signataire connecté). */
  sendInvitation(input: {
    requestId: string;
    contact: Contact;
    firstName: string;
    documentTitle: string;
    link: string;
    expiresOn: string;
  }): Promise<{ channel: CodeChannel }>;
}

/** Comptes lus dans identity (GetUsersByIds, jeton de service). */
export interface UserDirectory {
  find(userId: string): Promise<{
    firstName: string;
    lastName: string;
    phoneE164: string | null;
    /** Adresse vérifiée seulement. */
    email: string | null;
  } | null>;
}

/** Secrets : codes, jetons de lien, empreintes. */
export interface SecretTools {
  sha256(bytes: Uint8Array): string;
  newCode(length: number): string;
  /** HMAC du code lié à son identifiant (clé hors de la base). */
  hashCode(codeId: string, code: string): string;
  codeMatches(codeId: string, code: string, codeHash: string): boolean;
  /** Jeton aléatoire du lien de signature (32 octets, base64url). */
  newToken(): string;
  hashToken(token: string): string;
}

export interface DocumentSettings {
  issuer: Issuer;
  timeZone: string;
  codePolicy: CodePolicy;
  /** Adresse de « Mon espace KSP » (liens des messages), sans barre finale. */
  portalBaseUrl: string;
  /** Modèle de test autorisé (désactivé en production). */
  genericTemplateEnabled: boolean;
  /** Services métier autorisés à appeler DocumentInternalService. */
  internalCallers: readonly string[];
}

export interface DocumentDeps {
  documents: DocumentRepository;
  renderer: PdfRenderer;
  pdfs: PdfStore;
  notifier: SignatureNotifier;
  users: UserDirectory;
  secrets: SecretTools;
  settings: DocumentSettings;
  clock: Clock;
  ids: IdGenerator;
}
