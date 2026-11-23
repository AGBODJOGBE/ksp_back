import { type PlanOffer, type PlanScale } from '../domain/payment-plan';
import { type PricingObject, type PricingRule } from '../domain/pricing';
import { type ScoreWeights } from '../domain/score';
import { type RecoverySettings } from '../domain/settings';

/**
 * Ports de la couche application (ADR-060). Les adaptateurs vivent dans `infrastructure` : base du
 * service (Prisma), services appelés en gRPC avec le jeton de service, chiffrement du kit.
 */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

/** Qui agit : un membre du personnel, un créancier, un partenaire, le débiteur ou le système. */
export interface ActorRef {
  type: 'staff' | 'creditor' | 'debtor' | 'partner' | 'system';
  userId: string | null;
}

// ---------------------------------------------------------------------------------------------
// Réglages, jours fériés, tarification, audit (base du service)
// ---------------------------------------------------------------------------------------------

/**
 * Réglages complets du contrat `RecoverySettings` : ceux de la partie 17.1 (domaine `settings`), plus
 * les barèmes d'échéancier par défaut de chaque offre (6.1) et les poids du score (R-SD-07).
 */
export interface FullSettings extends RecoverySettings {
  scales: Record<PlanOffer, PlanScale>;
  scoreWeights: ScoreWeights;
}

export interface StoredSettings {
  settings: FullSettings;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface SettingsStore {
  /** Réglages enregistrés, ou null avant la première modification (valeurs par défaut). */
  load(): Promise<{ values: unknown; updatedAt: Date; updatedBy: string | null } | null>;
  save(values: FullSettings, by: string, at: Date): Promise<void>;
}

export interface Holiday {
  /** Jour au Bénin, « AAAA-MM-JJ ». */
  date: string;
  label: string;
}

export interface HolidayStore {
  listYear(year: number): Promise<Holiday[]>;
  /** Remplace la liste de l'année, dans une transaction. */
  replaceYear(year: number, holidays: readonly Holiday[]): Promise<void>;
  /** Jours fériés d'une période (calcul des jours ouvrés). */
  between(from: string, to: string): Promise<Holiday[]>;
}

/** Règle tarifaire telle qu'enregistrée : la règle du domaine et ses champs d'affichage. */
export interface StoredPricingRule {
  rule: PricingRule;
  label: string;
  creditorType: 'user' | 'organization' | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
  archiveReason: string | null;
  createdAt: Date;
}

export interface PricingRuleFilter {
  object?: PricingObject;
  statuses?: readonly string[];
  offer?: string;
  creditorId?: string;
}

export interface PricingRuleStore {
  find(id: string): Promise<StoredPricingRule | null>;
  findByIdempotencyKey(createdBy: string, key: string): Promise<StoredPricingRule | null>;
  list(
    filter: PricingRuleFilter,
    page: { limit: number; cursor: string | null },
  ): Promise<{
    items: StoredPricingRule[];
    nextCursor: string | null;
  }>;
  /** Règles du même objet (toutes cibles, hors archivées) : unicité de la règle en vigueur. */
  listByObject(object: PricingObject): Promise<StoredPricingRule[]>;
  insert(rule: StoredPricingRule, idempotencyKey: string | null): Promise<void>;
  update(rule: StoredPricingRule): Promise<void>;
  /**
   * Publication : enregistre la règle publiée et archive ou borne les règles qu'elle remplace, dans
   * une seule transaction.
   */
  publish(
    rule: StoredPricingRule,
    superseded: readonly { ruleId: string; action: 'archive' | 'end_at'; validUntil?: Date }[],
    at: Date,
  ): Promise<void>;
}

export interface AuditLog {
  record(entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

/** Dossiers ouverts d'un compte ou d'une organisation (obligations, UC-ID-11). */
export interface CaseObligations {
  openCases(creditor: { type: 'user' | 'organization'; id: string }): Promise<{ number: string }[]>;
}

// ---------------------------------------------------------------------------------------------
// Données personnelles des débiteurs (ADR-063)
// ---------------------------------------------------------------------------------------------

/** Chiffrement des coordonnées et empreintes de recherche, liés à un contexte (table et colonne). */
export interface PersonalData {
  encrypt(value: string, context: string): string;
  decrypt(value: string, context: string): string;
  phoneIndex(phone: string): string;
  emailIndex(email: string): string;
}

// ---------------------------------------------------------------------------------------------
// Services appelés (gRPC, jeton de service). Toute panne devient RECOVERY_DEPENDENCY_UNAVAILABLE.
// ---------------------------------------------------------------------------------------------

export interface Money {
  amount: number;
  currency: 'XOF';
}

export interface Holder {
  type: 'user' | 'organization';
  id: string;
}

/** Portefeuille (ADR-042, ADR-046) : frais et provisions débités, encaissements crédités au créancier. */
export interface WalletGateway {
  /** Débit du portefeuille prépayé (frais de dossier, provision) ; refus si le solde manque. */
  debit(input: {
    holder: Holder;
    amount: number;
    objectType: string;
    objectId: string;
    idempotencyKey: string;
    description: string;
  }): Promise<{ transactionId: string; created: boolean }>;
  /** Remboursement intégral d'un débit (idempotent par transaction chez wallet). */
  refund(input: { debitTransactionId: string; reason: string }): Promise<{ transactionId: string }>;
  /** Encaissement : brut, net au créancier, commission calculée par recovery (ADR-060). */
  recordCollection(input: {
    holder: Holder;
    gross: number;
    commission: number;
    commissionRateBps: number;
    reference: string;
    description: string;
  }): Promise<{ transactionId: string; created: boolean }>;
  /** Annulation d'un encaissement par écriture inverse (commission rendue), idempotente par référence. */
  reverseCollection(input: { transactionId: string; reference: string; reason: string }): Promise<{
    transactionId: string;
  }>;
  balance(holder: Holder): Promise<{ balance: number; prepaidBalance: number }>;
}

export interface PaymentLink {
  id: string;
  status: string;
  url: string;
  amount: number;
  expiresAt: string;
  paidAt: string | null;
}

/** Liens de paiement sans compte (ADR-040) : un seul lien payable par objet. */
export interface PaymentLinks {
  create(input: {
    idempotencyKey: string;
    subjectType: string;
    subjectId: string;
    reference: string;
    beneficiaryName: string;
    description: string;
    amount: number;
    expiresAt: Date;
    dueDate?: string;
  }): Promise<PaymentLink>;
  get(linkId: string): Promise<PaymentLink>;
  revoke(linkId: string, reason: string): Promise<PaymentLink>;
}

export interface GeneratedDocument {
  id: string;
  number: string;
  status: string;
  fileId: string;
}

/** Documents PDF et signature par code (ADR-044). */
export interface Documents {
  generate(input: {
    template: string;
    variables: Record<string, unknown>;
    subject: { type: string; id: string };
    ownerId?: string;
    idempotencyKey: string;
  }): Promise<GeneratedDocument>;
  requestSignature(input: {
    documentId: string;
    signer: { userId?: string; phone?: string; email?: string; displayName: string };
    expiresInHours?: number;
    notice?: 'link' | 'code';
    idempotencyKey: string;
  }): Promise<{ signatureId: string; status: string }>;
}

/** Fichiers des finalités du recouvrement (ADR-038) : pièces rattachées à un dossier. */
export interface Files {
  attach(input: { fileId: string; subject: { type: string; id: string }; ownerId?: string }): Promise<{
    fileId: string;
    contentType: string;
    sizeBytes: number;
  }>;
}

/**
 * Messages directs au débiteur (ADR-061), chacun lié à un modèle `recovery.debtor_*` de notification
 * (constantes de l'adaptateur) : notification n'accepte de recovery que ses propres modèles.
 */
export type DebtorMessage =
  | 'access_code'
  | 'mandate_notice'
  | 'reminder'
  | 'installment_reminder'
  | 'payment_link'
  | 'plan_confirmed'
  | 'formal_notice'
  | 'settlement_certificate'
  | 'dispute_received';

/** Premier canal de contact du débiteur : paramètre, son choix par défaut reste à trancher. */
export type DebtorChannel = 'whatsapp' | 'email';

/**
 * Message direct au débiteur (ADR-061) : coordonnées transmises à notification, jamais aux
 * événements. La clé d'idempotence est propre au message (dossier, objet, rang) ; l'adaptateur la
 * préfixe toujours par « recovery: », les clés de notification étant communes à tous les appelants.
 */
export interface Notifier {
  sendToDebtor(input: {
    message: DebtorMessage;
    channel: DebtorChannel;
    phone: string | null;
    email: string | null;
    variables: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ notificationId: string; status: string }>;
}

export interface PersonSummary {
  userId: string;
  displayName: string;
}

/** Comptes et organisations (identity) : noms affichés, sans coordonnées. */
export interface Directory {
  usersByIds(ids: readonly string[]): Promise<PersonSummary[]>;
  organizationsByIds(ids: readonly string[]): Promise<{ organizationId: string; displayName: string }[]>;
}
