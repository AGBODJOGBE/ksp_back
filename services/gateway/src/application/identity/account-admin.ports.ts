import { type Json } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur la recherche de compte du back-office d'identity (ADR-029), indépendante
 * de gRPC. L'utilisateur voyage dans le contexte de la requête ; identity revérifie ses droits.
 */
export interface AccountAdminApi {
  /** Compte d'un numéro E.164 : identifiant, nom, numéro masqué et état ; jamais l'e-mail. */
  findByPhone(phone: string): Promise<Json>;
}
