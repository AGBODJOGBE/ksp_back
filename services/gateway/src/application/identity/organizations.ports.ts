import { type Json, type Page } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur les comptes entreprise d'identity (ADR-027), indépendante de gRPC :
 * l'adaptateur traduit les corps REST en messages protobuf et les réponses en JSON du contrat
 * OpenAPI. L'utilisateur voyage dans le contexte de la requête ; identity revérifie ses droits.
 */
export interface NewOrganization {
  legalName: string;
  address: string;
  ifu: string;
  rccm?: string | undefined;
}

export type OrganizationDecision = 'validate' | 'reject' | 'suspend' | 'reactivate';

/** Un appel par méthode du contrat exposée en REST. */
export interface OrganizationsApi {
  /** Null : retour au contexte personnel. */
  switchContext(organizationId: string | null): Promise<Json>;
  listMine(): Promise<Json>;
  create(input: NewOrganization): Promise<Json>;
  getMine(id: string): Promise<Json>;
  changeBillingEmail(id: string, email: string): Promise<Json>;
  confirmBillingEmail(id: string, code: string): Promise<Json>;

  list(page: Page, status: string | undefined): Promise<Json>;
  get(id: string): Promise<Json>;
  /** Le motif accompagne le refus et la suspension. */
  decide(id: string, decision: OrganizationDecision, reason?: string): Promise<Json>;
}
