import { type PremisesType } from './catalog';
import { type Quote } from './quote';
import { type Recurrence } from './recurrence';
import { type Slot } from './schedule';

/**
 * Demande de devis (UC-CL-02 à 08) :
 * reçue → visite planifiée → devis envoyé → acceptée / refusée par le client / expirée / annulée,
 * ou refusée par KSP (motif obligatoire). Toute autre transition est refusée.
 */
export type RequestStatus =
  | 'received'
  | 'visit_scheduled'
  | 'quote_sent'
  | 'accepted'
  | 'declined'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export type CustomerKind = 'individual' | 'business';

const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  received: ['visit_scheduled', 'quote_sent', 'rejected', 'cancelled'],
  visit_scheduled: ['visit_scheduled', 'quote_sent', 'rejected', 'cancelled'],
  // Un devis révisé peut remplacer le précédent tant que le client n'a pas répondu ; une visite
  // des lieux peut encore être demandée avant l'acceptation (partie 10) : le devis devra être renvoyé.
  quote_sent: ['quote_sent', 'visit_scheduled', 'accepted', 'declined', 'expired', 'cancelled'],
  accepted: [],
  declined: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export const OPEN_REQUEST_STATUSES: readonly RequestStatus[] = ['received', 'visit_scheduled', 'quote_sent'];

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type VisitStatus = 'scheduled' | 'completed' | 'cancelled';

export interface SiteVisit {
  id: string;
  status: VisitStatus;
  scheduledAt: Date;
  agentId: string;
  report: string | null;
  completedAt: Date | null;
}

export interface QuoteRequest {
  id: string;
  status: RequestStatus;
  customerId: string;
  customerKind: CustomerKind;
  organizationId: string | null;
  serviceCode: string;
  premisesType: PremisesType;
  quantity: number;
  options: string[];
  commune: string;
  address: string;
  preferredSlots: Slot[];
  comment: string | null;
  recurrence: Recurrence | null;
  requestedTeamSize: number;
  /** Entreprise : jours d'intervention par semaine (1 à 7), null si non précisés. */
  daysPerWeek: number | null;
  recommendedTeamSize: number;
  estimate: { low: number; high: number } | null;
  visit: SiteVisit | null;
  quote: Quote | null;
  missionId: string | null;
  closingReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Version pour le contrôle de concurrence optimiste (double acceptation, etc.). */
  version: number;
}

/**
 * Visite des lieux obligatoire avant tout devis, pour toutes les demandes, particulier ou
 * entreprise (décision du 2026-10-23, qui remplace la règle « entreprise ou plus de 300 m² ») :
 * le devis ne peut être envoyé qu'après une visite réalisée.
 */
export const VISIT_REQUIRED = true;

export function canSendQuote(request: Pick<QuoteRequest, 'visit'>): boolean {
  return request.visit?.status === 'completed';
}

/** État affiché : un devis envoyé dont la validité est dépassée est expiré, même avant son archivage. */
export function effectiveRequestStatus(
  request: Pick<QuoteRequest, 'status' | 'quote'>,
  now: Date,
): RequestStatus {
  if (request.status === 'quote_sent' && request.quote && request.quote.validUntil <= now) return 'expired';
  return request.status;
}

export function isOpenRequest(request: Pick<QuoteRequest, 'status' | 'quote'>, now: Date): boolean {
  return OPEN_REQUEST_STATUSES.includes(effectiveRequestStatus(request, now));
}
