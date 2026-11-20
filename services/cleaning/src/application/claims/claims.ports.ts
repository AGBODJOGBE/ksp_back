import { type ClaimCategory, type ClaimOutcome, type ClaimState } from '../../domain/claims/claim';
import { type Changes } from '../ports';
import { type Page, type PageRequest } from '../shared/input';

/**
 * Dépôt des réclamations (partie 12, lot G). Chaque écriture est conditionnée par la version de la
 * réclamation et faite dans la même transaction que ses événements, ses traces et sa clé
 * d'idempotence ; une version dépassée remonte en ConcurrentUpdateError.
 */

/** Séance visée, avec le titulaire de son programme. */
export interface ClaimSessionRecord {
  id: string;
  programId: string;
  programNumber: string;
  rank: number;
  sessionsCount: number;
  status: string;
  completedAt: Date | null;
  start: Date;
  end: Date;
  ownerKind: 'user' | 'organization';
  ownerId: string;
  /** Titulaire, ou auteur de la demande pour une organisation. */
  customerId: string;
  organizationId: string | null;
  communeKey: string;
}

export interface ClaimMessageRecord {
  id: string;
  authorId: string;
  fromStaff: boolean;
  body: string;
  createdAt: Date;
}

export interface ClaimRecord extends ClaimState {
  id: string;
  session: ClaimSessionRecord;
  openedBy: string;
  category: ClaimCategory;
  text: string;
  photoFileIds: string[];
  decisionReason: string | null;
  decidedAt: Date | null;
  redoSessionId: string | null;
  openedAt: Date;
  closedAt: Date | null;
  version: number;
  messages: ClaimMessageRecord[];
}

export interface ClaimFilter {
  /** Réclamations d'un titulaire (espace client) ; null : toutes (back-office). */
  owner: { kind: 'user' | 'organization'; id: string } | null;
  status: string | null;
  agentId: string | null;
  customerId: string | null;
  organizationId: string | null;
  sort: 'openedAt' | '-openedAt';
}

export interface NewClaim {
  id: string;
  sessionId: string;
  openedBy: string;
  category: ClaimCategory;
  text: string;
  photoFileIds: readonly string[];
  at: Date;
}

/** Changement d'une réclamation, conditionné par sa version. */
export interface ClaimPatch {
  status?: ClaimState['status'];
  firstResponseAt?: Date | null;
  decision?: ClaimOutcome;
  decisionReason?: string;
  creditAmount?: number | null;
  decidedBy?: string;
  decidedAt?: Date;
  creditApprovedBy?: string;
  closedAt?: Date | null;
  message?: { id: string; authorId: string; fromStaff: boolean; body: string };
}

/** Repasse gratuite : séance à 0 FCFA ajoutée au programme (R-RC-03). */
export interface NewRedoSession {
  id: string;
  programId: string;
  communeKey: string;
  start: Date;
  end: Date;
}

/** Crédit au wallet à verser (clé fixe cleaning_claim_credit:<claimId>, RV-81). */
export interface NewClaimCredit {
  id: string;
  idempotencyKey: string;
  holder: { kind: 'user' | 'organization'; id: string };
  amount: number;
  label: string;
  sessionId: string;
  createdBy: string;
}

export interface PendingCredit extends NewClaimCredit {
  claimId: string;
}

export interface ClaimRepository {
  session(id: string): Promise<ClaimSessionRecord | null>;
  claim(id: string): Promise<ClaimRecord | null>;
  list(filter: ClaimFilter, page: PageRequest): Promise<Page<ClaimRecord>>;
  /** Fenêtre de réclamation et délai minimum avant une séance (réglages). */
  claimSettings(): Promise<{ windowHours: number; leadHours: number }>;
  /** Créneaux des séances non annulées du programme. */
  programSlots(programId: string): Promise<{ start: Date; end: Date }[]>;
  insert(claim: NewClaim, changes: Changes): Promise<void>;
  /**
   * Écrit le changement, la repasse et le crédit éventuels ; refuse (ConcurrentUpdateError) si la
   * version a changé.
   */
  update(
    id: string,
    expectedVersion: number,
    patch: ClaimPatch,
    effects: { redo: NewRedoSession | null; credit: NewClaimCredit | null; at: Date },
    changes: Changes,
  ): Promise<void>;
  /** Crédit de la réclamation encore « pending » ; null s'il n'y en a pas. */
  pendingCredit(claimId: string): Promise<PendingCredit | null>;
  /** Issue du crédit chez wallet. */
  settleCredit(
    operationId: string,
    outcome: {
      status: 'succeeded' | 'failed';
      transactionId: string | null;
      failureCode: string | null;
      at: Date;
    },
  ): Promise<void>;
}
