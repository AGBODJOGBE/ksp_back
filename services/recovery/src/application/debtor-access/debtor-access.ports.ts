import { type CaseStatus } from '../../domain/case';
import { type CodeAttempts, type DebtorLink } from '../../domain/debtor-access';

/**
 * Ports de l'accès du débiteur sans compte (ADR-061). Le lien et la session ont leurs tables
 * (`debtor_accesses`, `debtor_sessions`) ; le dossier et le débiteur, tenus par le dépôt des
 * dossiers, ne sont lus ici que par un petit port de lecture. Seules des empreintes sont
 * enregistrées : jamais un jeton, un code ni une session en clair.
 */

/** Lien du débiteur tel qu'enregistré : une ligne par jeton, l'ancienne révoquée au renouvellement. */
export interface StoredDebtorAccess {
  id: string;
  caseId: string;
  debtorId: string;
  link: DebtorLink;
  /** Code en cours (empreinte HMAC, échéance) ; null s'il n'y en a pas ou s'il a ouvert une session. */
  code: { hash: string; expiresAt: Date } | null;
  /** Dernier envoi d'un code (un par minute) et nombre de codes envoyés par ce lien. */
  codeSentAt: Date | null;
  codesSent: number;
  attempts: CodeAttempts;
}

export interface NewDebtorAccess {
  id: string;
  caseId: string;
  debtorId: string;
  tokenHash: string;
  link: DebtorLink;
}

export interface NewDebtorSession {
  id: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

/** Changement décidé par le cas d'usage sur un lien relu sous verrou ; champ absent : inchangé. */
export interface DebtorAccessChange {
  /** Nouveau code envoyé, ou null : code consommé par la session qu'il ouvre. */
  code?: { hash: string; expiresAt: Date } | null;
  /** Heure du dernier envoi (remise à sa valeur précédente quand l'envoi échoue). */
  codeSentAt?: Date | null;
  /** Un code de plus envoyé par ce lien. */
  countCodeSent?: true;
  attempts?: CodeAttempts;
  /** Session ouverte par un code juste, enregistrée dans la même transaction. */
  session?: NewDebtorSession;
}

/** Session du débiteur relue par l'empreinte de son jeton, avec le lien qui l'a ouverte. */
export interface StoredDebtorSession {
  id: string;
  accessId: string;
  caseId: string;
  debtorId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Révocation du lien (renouvelé, dossier clos) : ses sessions ne valent plus rien. */
  accessRevokedAt: Date | null;
}

export interface DebtorAccessStore {
  findByTokenHash(tokenHash: string): Promise<StoredDebtorAccess | null>;
  /**
   * Nouveau lien d'un débiteur, sous le verrou du débiteur : ses liens encore actifs dans le dossier
   * et leurs sessions sont révoqués dans la même transaction (un seul lien actif par débiteur et par
   * dossier). Rend le nombre de liens remplacés, ou null si le débiteur n'est pas dans ce dossier.
   */
  issue(access: NewDebtorAccess): Promise<{ replaced: number } | null>;
  /** Révoque les liens actifs d'un dossier, ou d'un de ses débiteurs, et leurs sessions. */
  revoke(scope: { caseId: string; debtorId?: string }, at: Date): Promise<number>;
  /**
   * Dossier clos (lecture seule) : ses liens encore valables à `at` le restent jusqu'à `until`,
   * prolongés ou raccourcis ; leurs sessions courent jusqu'à leur propre échéance. Rend leur nombre.
   */
  restrict(scope: { caseId: string }, until: Date, at: Date): Promise<number>;
  /**
   * Relit le lien sous verrou (SELECT … FOR UPDATE), laisse le cas d'usage décider et enregistre son
   * changement dans la même transaction : envois et essais sont comptés de façon atomique (ADR-050),
   * des appels simultanés passent l'un après l'autre. Lien inconnu : null.
   */
  updateLocked<T>(
    accessId: string,
    decide: (access: StoredDebtorAccess) => { change: DebtorAccessChange | null; result: T },
  ): Promise<T | null>;
  findSession(tokenHash: string): Promise<StoredDebtorSession | null>;
  /** Révoque une session encore ouverte ; false si elle l'était déjà. */
  endSession(sessionId: string, at: Date): Promise<boolean>;
}

/** Dossier d'un débiteur, vu de son accès : statut, numéro et créancier (son nom vient d'identity). */
export interface CaseDebtor {
  caseNumber: string;
  caseStatus: CaseStatus;
  creditor: { type: 'user' | 'organization'; id: string };
  /** Clôture du dossier : ouvre la lecture seule pendant N jours ; absente, aucun accès après la clôture. */
  closedAt?: Date | null;
}

/** Coordonnée chiffrée du débiteur (ADR-063), déchiffrée par le cas d'usage au moment de servir. */
export interface EncryptedContact {
  channel: 'phone' | 'email';
  valueEnc: string;
  /**
   * Contexte de chiffrement de la valeur (le dépôt des dossiers lie chaque coordonnée à sa ligne) ;
   * absent : `DEBTOR_CONTACT_CONTEXT`.
   */
  context?: string;
}

/** Lecture du dossier et du débiteur (tables du dépôt des dossiers). */
export interface DebtorCaseReader {
  /** Dossier du débiteur, ou null si ce débiteur n'appartient pas (ou plus) à ce dossier. */
  caseDebtor(caseId: string, debtorId: string): Promise<CaseDebtor | null>;
  /** Coordonnées valables du débiteur : la principale d'abord, puis la plus ancienne. */
  contacts(debtorId: string): Promise<EncryptedContact[]>;
}

export type DebtorAccessAction =
  | 'debtor_link_issued'
  | 'debtor_link_opened'
  | 'debtor_code_sent'
  | 'debtor_code_verified'
  | 'debtor_access_locked'
  | 'debtor_session_ended';

/**
 * Ligne du journal de preuve (R-PR-08) : identifiants seulement, aucune coordonnée, aucun jeton ni
 * code. Le débiteur agit sous son identifiant de débiteur (`actorId`), le système sans identifiant.
 */
export interface DebtorAccessEvent {
  caseId: string;
  accessId: string;
  occurredAt: Date;
  actorType: 'debtor' | 'system';
  actorId: string | null;
  action: DebtorAccessAction;
  channel: 'whatsapp' | 'email' | null;
  summary: string;
}

/** Journal de preuve du dossier (ajout seul), pour les actions de l'accès du débiteur. */
export interface DebtorAccessJournal {
  record(event: DebtorAccessEvent): Promise<void>;
}

/** Tirage cryptographique et empreintes (infrastructure) : jetons du lien et de la session, codes. */
export interface DebtorSecrets {
  /** 32 octets aléatoires en base64url, soit 43 caractères. */
  newToken(): string;
  /** Empreinte SHA-256 d'un jeton : seule elle est enregistrée et sert à le retrouver. */
  hashToken(token: string): string;
  /** Code de 6 chiffres. */
  newCode(): string;
  /** Empreinte HMAC-SHA256 du code, liée au lien ; la clé est hors de la base. */
  hashCode(accessId: string, code: string): string;
  /** Comparaison en temps constant d'un code saisi avec l'empreinte enregistrée. */
  codeMatches(accessId: string, code: string, hash: string): boolean;
}

/** Ce que l'accès du débiteur ajoute aux dépendances des cas d'usage (`RecoveryDeps.debtorAccess`). */
export interface DebtorAccessPorts {
  store: DebtorAccessStore;
  reader: DebtorCaseReader;
  journal: DebtorAccessJournal;
  secrets: DebtorSecrets;
  /** Page du portail qui reçoit le jeton : `<RECOVERY_DEBTOR_BASE_URL>/<jeton>`. */
  baseUrl: string;
  /**
   * Jours de lecture seule après la clôture (attestation de solde et reçus) :
   * `RECOVERY_DEBTOR_CLOSED_ACCESS_DAYS`, 30 par défaut ; 0 : liens révoqués à la clôture.
   */
  closedAccessDays?: number;
}
