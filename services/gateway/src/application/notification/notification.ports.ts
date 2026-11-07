import { type Json, type Page } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur le centre de notifications (ADR-038), indépendante de gRPC : l'adaptateur
 * traduit les requêtes en messages protobuf et les réponses en JSON du contrat OpenAPI.
 * L'utilisateur voyage dans le contexte de la requête.
 */
export interface DeliveryFilters {
  templateCode?: string | undefined;
  channel?: string | undefined;
  status?: string | undefined;
  /** Dates AAAA-MM-JJ (heure du Bénin), bornes incluses. */
  from?: string | undefined;
  to?: string | undefined;
  recipientUserId?: string | undefined;
}

/** Un appel par méthode du contrat ksp.notification.v1 exposée en REST. */
export interface NotificationApi {
  listMine(page: Page, unreadOnly: boolean): Promise<Json>;
  countUnread(): Promise<Json>;
  markRead(id: string): Promise<Json>;
  markAllRead(): Promise<Json>;
  getPreferences(): Promise<Json>;
  updatePreferences(input: { whatsapp: boolean; email: boolean }): Promise<Json>;
  listDeliveries(page: Page, filters: DeliveryFilters): Promise<Json>;
  getDelivery(id: string): Promise<Json>;
  listTemplates(): Promise<Json>;
}
