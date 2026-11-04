import { legacyPremisesType, legacyQuantity } from '../../domain/answers';
import { type GeocodingProvider } from '../../domain/location';
import { type QuoteRequest, type QuoteRequestGroup, VISIT_REQUIRED } from '../../domain/quote-request';
import { respectsLeadTime } from '../../domain/schedule';
import { calculatePrice } from '../../domain/simulator';
import { communeKey } from '../../domain/location';
import { findActiveZone } from '../../domain/zone';
import { type CleaningDeps, presentRequest } from '../deps';
import { type AuditEntry, type OutboxMessage, type QuoteRequestGroupView } from '../ports';
import { MAX_PREFERRED_SLOTS } from '../requests/customer-requests.use-cases';
import { currentCustomer, requireStaff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import {
  optionalText,
  parseRecurrence,
  parseSlot,
  requiredText,
  requirePositiveInt,
  requireUuid,
} from '../shared/validation';
import { locate, parseLocation } from './location.use-cases';
import { activePlaceType, type PlaceItemInput, resolvePlaceItems } from './place-items';

/**
 * Plusieurs prestations pour un même lieu (ADR-034) : une demande de devis par prestation, liées
 * par un groupe (même lieu, même position, même repère, mêmes créneaux, même commentaire). Chaque
 * demande suit ensuite son circuit habituel (devis, mission, paiement, facturation), sans changement.
 */
export interface QuoteGroupItemInput extends PlaceItemInput {
  /** 0 ou absent : taille recommandée par la règle de la prestation. */
  requestedTeamSize?: number | undefined;
}

export interface RequestQuoteGroupInput {
  idempotencyKey: string;
  placeType: string;
  location: { latitude: number; longitude: number; accuracyMeters?: number | null | undefined } | undefined;
  landmark: string;
  /** Repli : commune choisie par le client, utilisée seulement si le géocodage ne trouve rien. */
  commune?: string | null | undefined;
  items: QuoteGroupItemInput[];
  preferredSlots: { start: string; end: string }[];
  comment?: string | null | undefined;
  recurrence?: { period: string; visitsPerPeriod: number; durationMonths: number } | undefined;
}

/** Commune retenue pour le groupe : celle du géocodage, jamais celle du client quand il réussit. */
interface ChosenCommune {
  commune: string;
  provider: GeocodingProvider | null;
  displayAddress: string | null;
}

/** Groupe tel qu'il s'affiche : un devis dont la validité est dépassée apparaît expiré. */
function presentGroup(view: QuoteRequestGroupView, now: Date): QuoteRequestGroupView {
  return { group: view.group, requests: view.requests.map((request) => presentRequest(request, now)) };
}

/** Clé d'idempotence d'une demande du groupe : unique pour le client (identifiant du groupe). */
export const groupRequestKey = (groupId: string, index: number) => `group:${groupId}:${index}`;

export class RequestQuoteGroupUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: RequestQuoteGroupInput): Promise<QuoteRequestGroupView> {
    const customer = currentCustomer();
    const key = requiredText('idempotencyKey', input.idempotencyKey, 100);
    const now = this.deps.clock.now();
    const replay = await this.deps.requests.findGroupByIdempotencyKey(customer.userId, key);
    if (replay) return presentGroup(replay, now);
    // Jeton émis avant la suspension de l'organisation (15 minutes au plus, ADR-027) : refusé ici.
    if (customer.organizationId && (await this.deps.organizations.isSuspended(customer.organizationId))) {
      throw CleaningErrors.organizationSuspended();
    }

    const placeType = await activePlaceType(this.deps, input.placeType);
    const location = parseLocation(input.location);
    const landmark = requiredText('landmark', input.landmark, 500);
    const fallbackCommune = optionalText('commune', input.commune ?? undefined, 100);
    const comment = optionalText('comment', input.comment ?? undefined, 2000);
    const recurrence = parseRecurrence(input.recurrence);
    const items = await resolvePlaceItems(this.deps, placeType, input.items);
    const teamSizes = input.items.map((item, index) =>
      item.requestedTeamSize
        ? requirePositiveInt(`items[${index}].requestedTeamSize`, item.requestedTeamSize, 50)
        : 0,
    );

    const settings = await this.deps.catalog.getSettings();
    if (input.preferredSlots.length < 1 || input.preferredSlots.length > MAX_PREFERRED_SLOTS) {
      throw CleaningErrors.slotInvalid(`Proposez de 1 à ${MAX_PREFERRED_SLOTS} créneaux.`);
    }
    const preferredSlots = input.preferredSlots.map((slot, index) =>
      parseSlot(`preferredSlots[${index}]`, slot),
    );
    if (preferredSlots.some((slot) => !respectsLeadTime(slot.start, now, settings.minimumLeadHours))) {
      throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
    }
    const { commune, provider, displayAddress } = await this.chooseCommune(location, fallbackCommune);
    // Chaque prestation est une demande ouverte : le plafond s'applique au groupe entier.
    const open = await this.deps.requests.countOpen(customer.userId, now);
    if (open + items.length > settings.maxOpenRequests) {
      throw CleaningErrors.tooManyOpenRequests(settings.maxOpenRequests);
    }

    const group: QuoteRequestGroup = {
      id: this.deps.ids.next(),
      customerId: customer.userId,
      placeType: placeType.code,
      commune,
      createdAt: now,
    };
    const events: OutboxMessage[] = [];
    const audit: AuditEntry[] = [];
    const requests = items.map(({ service, form }, index): QuoteRequest => {
      const requestedTeamSize = teamSizes[index]!;
      // Prix recalculé avec la vraie commune (la simulation a pu être faite sans elle).
      const calculation = calculatePrice(service, { ...form, commune, requestedTeamSize });
      const request: QuoteRequest = {
        id: this.deps.ids.next(),
        status: 'received',
        customerId: customer.userId,
        customerKind: customer.kind,
        organizationId: customer.organizationId,
        serviceCode: service.code,
        premisesType: legacyPremisesType(form.answers),
        quantity: legacyQuantity(service, form.answers),
        options: form.options.map((option) => option.code),
        answers: form.answers,
        optionSelections: form.options,
        frequency: form.frequency,
        pricingVersion: service.pricing.version,
        calculation,
        commune,
        // Le point de repère tient lieu d'adresse d'intervention pour les lecteurs existants.
        address: landmark,
        groupId: group.id,
        placeType: placeType.code,
        location,
        landmark,
        geocodingProvider: provider,
        geocodedAddress: displayAddress,
        preferredSlots,
        comment,
        recurrence,
        requestedTeamSize,
        daysPerWeek: null,
        recommendedTeamSize: calculation.recommendedTeamSize,
        estimate: calculation.estimate,
        visit: null,
        quote: null,
        missionId: null,
        closingReason: null,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      events.push({
        type: 'cleaning.quote.requested',
        payload: {
          requestId: request.id,
          customerId: customer.userId,
          organizationId: customer.organizationId,
          customerKind: customer.kind,
          serviceCode: service.code,
          visitRequired: VISIT_REQUIRED,
          groupId: group.id,
        },
      });
      audit.push({
        actorId: customer.userId,
        action: 'request.created',
        entityType: 'quote_request',
        entityId: request.id,
        at: now,
        details: { groupId: group.id, placeType: placeType.code, geocodingProvider: provider },
      });
      return request;
    });
    audit.push({
      actorId: customer.userId,
      action: 'request_group.created',
      entityType: 'request_group',
      entityId: group.id,
      at: now,
      details: {
        placeType: placeType.code,
        requestIds: requests.map((request) => request.id),
        serviceCodes: requests.map((request) => request.serviceCode),
        geocodingProvider: provider,
      },
    });
    const result = await this.deps.requests.createGroup(group, requests, key, { events, audit });
    return presentGroup(result.value, now);
  }

  /**
   * Commune du groupe : celle trouvée par géocodage (la commune envoyée est alors ignorée), refusée
   * si elle n'est pas desservie ; sans résultat, celle choisie par le client, contrôlée de même.
   */
  private async chooseCommune(
    location: { latitude: number; longitude: number },
    fallback: string | null,
  ): Promise<ChosenCommune> {
    const { place, match } = await locate(this.deps, location);
    if (place && match) {
      if (!match.zone) throw CleaningErrors.zoneNotCovered(match.commune);
      return { commune: match.zone.commune, provider: place.provider, displayAddress: place.displayAddress };
    }
    if (!fallback) throw CleaningErrors.locationUnresolved();
    const zone = findActiveZone(await this.deps.catalog.listZones(), communeKey(fallback));
    if (!zone) throw CleaningErrors.zoneNotCovered(fallback);
    return { commune: zone.commune, provider: null, displayAddress: place?.displayAddress ?? null };
  }
}

/** Groupe du client et ses demandes ; celui d'un autre client est introuvable (404). */
export class GetMyRequestGroupUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(groupId: string): Promise<QuoteRequestGroupView> {
    const customer = currentCustomer();
    const view = await this.deps.requests.findGroup(requireUuid('groupId', groupId));
    if (!view || view.group.customerId !== customer.userId) throw CleaningErrors.requestGroupNotFound();
    return presentGroup(view, this.deps.clock.now());
  }
}

/**
 * Back-office : demandes sœurs d'une demande groupée, telles qu'elles s'affichent (état, visite,
 * devis, mission) ; vide pour une demande seule.
 */
export class ListGroupSiblingsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(request: Pick<QuoteRequest, 'id' | 'groupId'>): Promise<QuoteRequest[]> {
    requireStaff(SUPERVISION);
    if (!request.groupId) return [];
    const view = await this.deps.requests.findGroup(request.groupId);
    const now = this.deps.clock.now();
    return (view?.requests ?? [])
      .filter((sibling) => sibling.id !== request.id)
      .map((sibling) => presentRequest(sibling, now));
  }
}
