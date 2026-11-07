import { type Json } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur la recherche de compte du back-office d'identity (ADR-029), indépendante
 * de gRPC. L'utilisateur voyage dans le contexte de la requête ; identity revérifie ses droits.
 */
export interface AccountAdminApi {
  /** Compte d'un numéro E.164 : identifiant, nom, numéro masqué et état ; jamais l'e-mail. */
  findByPhone(phone: string): Promise<Json>;
  /** Administration des comptes (ADR-038) : chaque écriture renvoie la fiche à jour. */
  search(input: { query?: string; limit?: number; cursor?: string }): Promise<Json>;
  get(userId: string): Promise<Json>;
  listAssignableRoles(): Promise<Json>;
  grantRole(userId: string, roleCode: string, reason: string): Promise<Json>;
  revokeRole(userId: string, assignmentId: string, reason: string): Promise<Json>;
  changeStatus(userId: string, action: AccountStatusAction, reason: string): Promise<Json>;
  resetMfa(userId: string, reason: string): Promise<Json>;
}

export type AccountStatusAction = 'suspend' | 'reactivate';
