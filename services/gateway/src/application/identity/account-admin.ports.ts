import { type Json } from '../common/api.ports';

/**
 * Vue de la gateway sur la recherche de compte du back-office d'identity (ADR-029), indépendante
 * de gRPC. L'utilisateur voyage dans le contexte de la requête ; identity revérifie ses droits.
 */
export interface AccountAdminApi {
  /** Compte d'un numéro E.164 : identifiant, nom, numéro masqué et état ; jamais l'e-mail. */
  findByPhone(phone: string): Promise<Json>;
  /** Administration des comptes (ADR-043) : chaque écriture renvoie la fiche à jour. */
  search(input: { query?: string; limit?: number; cursor?: string }): Promise<Json>;
  get(userId: string): Promise<Json>;
  listAssignableRoles(): Promise<Json>;
  /** `zoneKeys` : attribution limitée à ces communes (R-RB-03) ; absent : portée du rôle. */
  grantRole(userId: string, roleCode: string, reason: string, zoneKeys?: string[]): Promise<Json>;
  revokeRole(userId: string, assignmentId: string, reason: string): Promise<Json>;
  changeStatus(userId: string, action: AccountStatusAction, reason: string): Promise<Json>;
  resetMfa(userId: string, reason: string): Promise<Json>;
  /** Rôles dynamiques du super administrateur (R-RB-01, R-RB-02 ; ADR-057). */
  listPermissions(input: { service?: string; includeRetired: boolean }): Promise<Json>;
  getRole(code: string): Promise<Json>;
  createRole(input: RoleInput & { code: string; name: string; permissions: string[] }): Promise<Json>;
  updateRole(code: string, input: RoleInput): Promise<Json>;
  deactivateRole(code: string, reason: string): Promise<Json>;
}

/** Champs d'un rôle géré ; `permissions` absent à la modification : inchangées. */
export interface RoleInput {
  name?: string;
  description?: string;
  sensitive?: boolean;
  permissions?: string[];
  reason: string;
}

export type AccountStatusAction = 'suspend' | 'reactivate';
