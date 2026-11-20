import { type CleaningEventPayloads, type CleaningEventType } from '@ksp/contracts';

/**
 * Ports du service cleaning (refonte v2, ADR-054). Le métier v2 est livré lot par lot : chaque lot
 * ajoute ici les ports de ses dépôts. Chaque écriture porte ses événements (outbox) et ses traces
 * (auteur, date) : l'adaptateur les enregistre dans la même transaction que l'état.
 */

/** Un événement publié par cleaning : l'un des 45 événements v2 du contrat (partie 15.5). */
export type OutboxMessage = {
  [K in CleaningEventType]: { type: K; payload: CleaningEventPayloads[K] };
}[CleaningEventType];

/**
 * Trace du journal d'audit, écrite dans la même transaction que la décision. Liste fermée des
 * actions : règle R-AU-01 (reprise RV-12), reprise par chaque lot.
 */
export interface AuditEntry {
  /** Compte de l'auteur, ou `system` pour une tâche automatique. */
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  at: Date;
  /** Identifiants, avant et après, montants : jamais de position, d'adresse, de repère ni de texte libre. */
  details?: Record<string, unknown>;
}

export interface Changes {
  events: OutboxMessage[];
  audit: AuditEntry[];
}

/** Débit du wallet d'un titulaire (wallet.Debit, ADR-046). */
export interface WalletDebit {
  transactionId: string;
  amount: number;
  created: boolean;
}

/**
 * Wallet du client (service wallet, jeton de service, ADR-046). Débit jamais partiel : solde
 * insuffisant → AppError WALLET_INSUFFICIENT_FUNDS (montant manquant), transmise telle quelle au
 * client. Idempotent par clé. Remboursement d'un débit : une seule fois.
 */
export interface WalletLedger {
  debit(input: {
    idempotencyKey: string;
    holder: { type: 'user' | 'organization'; id: string };
    amount: number;
    object: { objectType: string; objectId: string; part: string };
    description: string;
  }): Promise<WalletDebit>;
  refund(input: { transactionId: string; reason: string }): Promise<void>;
}

/** Types d'objet des fichiers du Nettoyage chez file (reprise RV-102). */
export type FileSubjectType =
  'cleaning_request' | 'cleaning_visit' | 'cleaning_session' | 'cleaning_claim' | 'cleaning_agent';

/** Objet métier auquel un fichier est rattaché chez file. */
export interface FileSubject {
  type: FileSubjectType;
  id: string;
}

export interface StoredPhoto {
  fileId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
  downloadUrl: string | null;
  downloadExpiresAt: Date | null;
}

/**
 * Photos et pièces chez le service file (FileInternalService, ADR-038). Le fichier est rattaché au
 * nom de l'appelant avant que cleaning n'enregistre sa référence (reprise RV-102). Les erreurs de
 * file sont transmises telles quelles.
 */
export interface PhotoStore {
  /** Rattache à l'objet un fichier envoyé par `ownerId` lui-même. */
  attach(input: { fileId: string; subject: FileSubject; ownerId: string }): Promise<void>;
  remove(fileId: string, subject: FileSubject): Promise<void>;
  /** Fichiers disponibles rattachés à l'objet, avec leurs adresses de lecture. */
  list(subject: FileSubject): Promise<StoredPhoto[]>;
}

/** Point GPS (degrés décimaux). Donnée personnelle : jamais journalisée. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Fournisseurs du géocodage inverse, côté geo (ADR-034, ADR-045). */
export const GEOCODING_PROVIDERS = ['nominatim', 'google'] as const;
export type GeocodingProvider = (typeof GEOCODING_PROVIDERS)[number];

/** Réponse du géocodage inverse : noms candidats de la commune et adresse lisible. */
export interface GeocodedPlace {
  provider: GeocodingProvider;
  communes: string[];
  displayAddress: string | null;
}

/**
 * Géocodage inverse par geo (ReverseGeocode) : adresse lisible d'un point. Null si geo ne répond
 * pas ou ne trouve rien ; jamais d'erreur. En v2, la commune vient du contour officiel
 * (geo.ResolveCommune, ADR-059) : ce port sert l'adresse lisible (reprise RV-47).
 */
export interface ReverseGeocoder {
  reverse(point: GeoPoint): Promise<GeocodedPlace | null>;
}

/**
 * Noms affichés au back-office (ADR-029), lus dans identity au moment de la réponse : prénom et
 * nom d'un compte, raison sociale d'une organisation. Lecture au mieux : un identifiant inconnu
 * est absent, et une panne d'identity rend des noms absents au lieu d'une erreur. Aucun nom n'est
 * enregistré dans cleaning.
 */
export interface PeopleDirectory {
  userNames(userIds: readonly string[]): Promise<Map<string, string>>;
  organizationNames(organizationIds: readonly string[]): Promise<Map<string, string>>;
}

export interface Clock {
  now(): Date;
}

/** Identifiants UUID v7 (triables par date de création). */
export interface IdGenerator {
  next(): string;
}

/**
 * Chiffrement des données personnelles en base (partie 16.3) : pièce d'identité, personne à
 * prévenir, numéro Mobile Money d'un agent, position d'un lieu. Le contexte (objet et champ) lie le
 * chiffré à sa ligne : recopié ailleurs, il ne se déchiffre pas.
 */
export interface FieldCipher {
  encrypt(plaintext: string, context: string): string;
  /** Lève une erreur si le chiffré est illisible (autre clé, autre contexte, modifié). */
  decrypt(ciphertext: string, context: string): string;
}
