import { type AccountAction, type AccountQuery } from '../../domain/role/role-administration';
import { type RoleDefinition, type RoleScopeType } from '../../domain/role/role';
import { type UserStatusName } from '../session/session.ports';

/** Un compte vu par l'administration (ADR-043). */
export interface AdminAccountView {
  id: string;
  status: UserStatusName;
  firstName: string | null;
  lastName: string | null;
  phoneE164: string | null;
  createdAt: Date;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  /** Codes des rôles actifs, dans l'ordre d'attribution. */
  roleCodes: string[];
}

/** Une attribution de rôle, active ou retirée, avec le nom de ses auteurs. */
export interface RoleAssignmentView {
  id: string;
  role: RoleDefinition;
  scopeType: RoleScopeType;
  scopeId: string | null;
  grantedAt: Date;
  grantedBy: string | null;
  grantedByName: string | null;
  grantReason: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokedByName: string | null;
  revokeReason: string | null;
}

/** Une action tracée dans le journal d'audit pour ce compte. */
export interface AccountAuditView {
  id: string;
  action: string;
  at: Date;
  actorId: string;
  actorName: string | null;
  roleCode: string | null;
  reason: string | null;
}

export interface MfaStatusView {
  /** Application d'authentification confirmée ; null si elle n'est pas configurée. */
  configuredAt: Date | null;
  recoveryCodesRemaining: number;
  /** Il existe quelque chose à effacer (application, même non confirmée, ou codes). */
  resettable: boolean;
}

export interface AccountSearch {
  query: AccountQuery;
  /** Métiers de l'appelant : la recherche se limite aux comptes qui ont un rôle actif de l'un d'eux. Null : tous les comptes. */
  teamOf: readonly string[] | null;
  limit: number;
  /** Identifiant du dernier compte de la page précédente (UUID v7, ordre décroissant). */
  cursor: string | null;
}

/** Changement d'état d'un compte, appliqué s'il est toujours dans l'état `from`. */
export interface AccountStatusChange {
  userId: string;
  action: AccountAction;
  from: UserStatusName;
  to: UserStatusName;
  actorId: string;
  reason: string;
  auditId: string;
  now: Date;
}

/** Le compte a changé d'état entre la lecture et l'écriture. */
export class AccountStatusChangedError extends Error {
  override readonly name = 'AccountStatusChangedError';
}

export interface AccountAdminRepository {
  /** Comptes non supprimés, les plus récents d'abord, après le curseur. */
  search(search: AccountSearch): Promise<{ items: AdminAccountView[]; nextCursor: string | null }>;
  /** Compte, quel que soit son état (supprimé compris). */
  findAccount(userId: string): Promise<AdminAccountView | null>;
  /** Toutes les attributions du compte, actives d'abord, puis les plus récentes. */
  assignments(userId: string): Promise<RoleAssignmentView[]>;
  /** Journal d'audit du compte, le plus récent d'abord. */
  history(userId: string, limit: number): Promise<AccountAuditView[]>;
  mfaStatus(userId: string): Promise<MfaStatusView>;
  /** Catalogue des rôles enregistrés. */
  catalog(): Promise<RoleDefinition[]>;
  /**
   * Suspend ou réactive le compte s'il est toujours dans l'état de départ, avec l'événement, la
   * trace d'audit et, pour une suspension, la fermeture de toutes ses sessions, en une transaction.
   * Lève AccountStatusChangedError, et LastSuperAdminError si la suspension retirerait le dernier
   * super administrateur actif.
   */
  changeStatus(change: AccountStatusChange): Promise<void>;
  /**
   * Efface l'application d'authentification et les codes de récupération, ferme les sessions du
   * back-office et les étapes de double authentification ouvertes, trace l'action. Renvoie false
   * s'il n'y avait rien à effacer.
   */
  resetMfa(change: {
    userId: string;
    actorId: string;
    reason: string;
    auditId: string;
    now: Date;
  }): Promise<boolean>;
}
