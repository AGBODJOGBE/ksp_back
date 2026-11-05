import { type Answers, type OptionSelection, type PremisesType } from './answers';
import { type GeocodingProvider, type GeoLocation } from './location';
import { type Quote } from './quote';
import { type Recurrence } from './recurrence';
import { type Slot } from './schedule';
import { type PriceCalculation } from './simulator';

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
  /**
   * Visite commune à plusieurs demandes d'un groupe (ADR-035) : même identifiant pour toutes ;
   * absent ou null pour une visite propre à la demande (ou détachée de la visite de groupe).
   */
  groupVisitId?: string | null;
}

export interface QuoteRequest {
  id: string;
  status: RequestStatus;
  customerId: string;
  customerKind: CustomerKind;
  organizationId: string | null;
  serviceCode: string;
  /** Déprécié (ADR-033) : valeur déduite des réponses, pour les anciens lecteurs. */
  premisesType: PremisesType;
  /** Déprécié (ADR-033) : réponse au champ de la taille d'équipe, 1 sinon. */
  quantity: number;
  /** Codes des options choisies. */
  options: string[];
  /** Réponses au formulaire (ancien format converti) ; null pour une demande antérieure à l'ADR-033. */
  answers: Answers | null;
  optionSelections: OptionSelection[];
  frequency: string | null;
  /** Version de la grille du calcul, null pour une demande antérieure. */
  pricingVersion: number | null;
  /** Détail du calcul au moment de la demande, null pour une demande antérieure. */
  calculation: PriceCalculation | null;
  /**
   * Mesures constatées sur le terrain après la visite (ADR-037) : elles ne remplacent jamais les
   * réponses du client, gardées pour l'historique. Absent ou null : aucune mesure.
   */
  measurement?: Measurement | null;
  commune: string;
  address: string;
  /** Groupe des demandes créées ensemble pour un même lieu (ADR-034), null pour une demande seule. */
  groupId: string | null;
  /** Type de lieu choisi par le client, null pour une demande sans lieu. */
  placeType: string | null;
  /** Position GPS du lieu (donnée personnelle : jamais journalisée ni publiée), null sans position. */
  location: GeoLocation | null;
  /** Point de repère donné par le client, null sans position. */
  landmark: string | null;
  /** Fournisseur qui a trouvé la commune ; null si elle a été choisie par le client. */
  geocodingProvider: GeocodingProvider | null;
  /** Adresse lisible rendue par le géocodeur pour la position, null si aucune. */
  geocodedAddress: string | null;
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
 * Mesures constatées par l'agent ou le superviseur (ADR-037) : mêmes réponses que le formulaire
 * du client, calculées avec la grille en vigueur et la commune de la demande au moment de la saisie.
 */
export interface Measurement {
  answers: Answers;
  optionSelections: OptionSelection[];
  frequency: string | null;
  calculation: PriceCalculation;
  pricingVersion: number;
  measuredAt: Date;
  measuredBy: string;
}

/** Mesures modifiables tant qu'aucun devis n'est envoyé (ou après une nouvelle visite) : demande reçue ou visite planifiée. */
const MEASURABLE_STATUSES: readonly RequestStatus[] = ['received', 'visit_scheduled'];

export function canRecordMeasurements(request: Pick<QuoteRequest, 'status' | 'quote'>, now: Date): boolean {
  return MEASURABLE_STATUSES.includes(effectiveRequestStatus(request, now));
}

/**
 * Groupe de demandes (ADR-034) : plusieurs prestations pour un même lieu, une demande de devis
 * par prestation, créées ensemble. Chaque demande suit ensuite son propre circuit.
 */
export interface QuoteRequestGroup {
  id: string;
  customerId: string;
  placeType: string;
  /** Commune retenue : trouvée par géocodage, ou choisie par le client en repli. */
  commune: string;
  createdAt: Date;
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
