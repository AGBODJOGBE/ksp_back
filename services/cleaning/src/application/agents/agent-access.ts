import { staffWith } from '../requests/staff';

/** Permission de l'admin Nettoyage sur les agents (cahier des charges, partie 2). */
export const AGENT_MANAGE_PERMISSION = 'cleaning.agent.manage';

/**
 * Admin Nettoyage au back-office (pièce d'identité, création et invitation d'un agent) : appel venu
 * de la gateway, double authentification faite pendant la session, et permission revérifiée dans
 * le service quand le jeton en porte (partie 16.3, ADR-057). Renvoie son compte.
 */
export function requireAgentAdmin(): string {
  return staffWith(AGENT_MANAGE_PERMISSION);
}
