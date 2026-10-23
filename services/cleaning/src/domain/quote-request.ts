import { type PremisesType, type ServiceUnit } from './catalog';
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
  // Un devis révisé peut remplacer le précédent tant que le client n'a pas répondu.
  quote_sent: ['quote_sent', 'accepted', 'declined', 'expired', 'cancelled'],
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
 * Visite technique obligatoire pour un client entreprise, ou pour une surface au-delà du seuil
 * (300 m² par défaut).
 */
export function isVisitRequired(
  customerKind: CustomerKind,
  unit: ServiceUnit,
  quantity: number,
  thresholdSquareMeters: number,
): boolean {
  return customerKind === 'business' || (unit === 'square_meter' && quantity > thresholdSquareMeters);
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
