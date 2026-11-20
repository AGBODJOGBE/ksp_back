import { type ParameterValue } from '../../domain/pricing/types';
import { submitRequest, type TimeSlot } from '../../domain/requests/request-lifecycle';
import { countOpenRequests } from '../../domain/requests/request-status';
import { type CleaningDeps } from '../deps';
import { previewSchedule, type SchedulePlanInput, toSchedulePlan } from '../simulation/schedule';
import { simulate, type ValueInput } from '../simulation/simulate.use-cases';
import { CleaningErrors, cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { instant, requireUuid, text } from '../shared/input';
import { caseErrors, decide } from './case-errors';
import { audit, timelineOf } from './case-support';
import { currentCustomer } from './customer';
import { decryptLocation, encryptLocation } from './locations';
import { requireActor } from './places.use-cases';
import { type CaseRecord, type DeclaredRow, type RequestRecord } from './requests.ports';
import { debitVisitFee, SYSTEM_ACTOR } from './visit-fee-money';

/**
 * UC-NT-04 — Demander un devis (R-DM-01 à 08, R-FV-01, R-FV-02, R-CA-05). Prix recalculé côté
 * serveur avec la commune du lieu ; la demande garde le détail du calcul et la version de chaque
 * tarif. La position du lieu est copiée, chiffrée, dans la demande (R-DM-08). Les frais de visite
 * sont débités aussitôt du wallet du contexte actif ; solde insuffisant : « frais à payer ».
 */
export interface SubmitRequestInput {
  idempotencyKey: string;
  placeId: string;
  cleaningTypeIds: string[];
  values: Record<string, ValueInput>;
  freeDescription?: string | undefined;
  schedule?: SchedulePlanInput | undefined;
  visitSlots: { start: string; end: string }[];
  comment?: string | undefined;
  photoFileIds: string[];
}

/** 7.1 : jusqu'à 5 photos du lieu. */
export const MAX_REQUEST_PHOTOS = 5;

export function parseSlots(slots: readonly { start: string; end: string }[]): TimeSlot[] {
  return slots.map((slot, index) => ({
    start: instant(slot.start, `visitSlots[${index}].start`),
    end: instant(slot.end, `visitSlots[${index}].end`),
  }));
}

export class SubmitRequestUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: SubmitRequestInput): Promise<CaseRecord> {
    const customer = currentCustomer();
    requireActor(customer);
    const placeId = requireUuid(input.placeId, 'placeId');
    const cleaningTypeIds = input.cleaningTypeIds.map((id, index) =>
      requireUuid(id, `cleaningTypeIds[${index}]`),
    );
    if (!input.schedule) throw CleaningErrors.validation('schedule', 'required');
    const schedulePlan = toSchedulePlan(input.schedule);
    const slots = parseSlots(input.visitSlots);
    const description = text(input.freeDescription, 'freeDescription');
    const comment = text(input.comment, 'comment');
    if (input.photoFileIds.length > MAX_REQUEST_PHOTOS) {
      throw cleaningErrors.invalid('photoFileIds', 'out_of_range');
    }
    const photoFileIds = input.photoFileIds.map((id, index) => requireUuid(id, `photoFileIds[${index}]`));
    const now = this.deps.clock.now();
    const body = { ...input, idempotencyKey: undefined, owner: customer.owner };

    const created = await runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'request.submit',
      key: input.idempotencyKey,
      body,
      at: now,
      replay: async (response) => ({ requestId: String(response.requestId), fresh: false }),
      run: async (stub) => {
        const place = await this.deps.clientPlaces.findPlace(placeId);
        if (
          !place ||
          place.archivedAt ||
          place.owner.kind !== customer.owner.kind ||
          place.owner.id !== customer.owner.id
        ) {
          throw caseErrors.placeNotFound();
        }
        const location = decryptLocation(this.deps.cipher, 'place', place.id, place);
        if (!location) throw caseErrors.placeLocationMissing();
        const placeType = await this.deps.places.getPlaceType(place.placeTypeId);
        if (!placeType?.active) throw CleaningErrors.placeTypeNotFound();
        const zone = await this.deps.zones.findByCommune(place.communeKey);
        if (!zone?.active) {
          throw caseErrors.zoneNotCovered('commune_not_served', {
            key: place.communeKey,
            name: place.communeKey,
          });
        }
        const [settings, standing, open] = await Promise.all([
          this.deps.caseSettings.caseSettings(),
          customer.organizationId
            ? this.deps.cases.organizationStanding(customer.organizationId)
            : Promise.resolve({ suspended: false, unpaidInvoices: 0 }),
          this.deps.cases.openCandidates(customer.owner),
        ]);

        // R-CA-05 : lieu « Autre », besoin décrit en texte et aucun prix ; sinon calcul du simulateur.
        const values = input.values as Record<string, ParameterValue>;
        let pricing: Awaited<ReturnType<typeof simulate>> | null = null;
        let visitFeeAmount: number;
        if (placeType.isOther) {
          if (!description) throw cleaningErrors.invalid('freeDescription', 'required');
          await previewSchedule(this.deps, schedulePlan);
          const category = await this.deps.places.getCategory(placeType.categoryId);
          visitFeeAmount = (category?.visitFee ?? settings.defaultVisitFee) + (zone.visitFeeSurcharge ?? 0);
        } else {
          pricing = await simulate(
            this.deps,
            {
              placeTypeId: placeType.id,
              cleaningTypeIds,
              values: input.values,
              schedule: input.schedule,
              communeKey: place.communeKey,
            },
            { acceptInactive: false, draftTariffIds: [] },
          );
          visitFeeAmount = pricing.visitFee;
        }

        const requestId = this.deps.ids.next();
        const feeId = this.deps.ids.next();
        const submitted = decide(() =>
          submitRequest({
            openCount: countOpenRequests(open.map(timelineOf), now),
            maxOpenRequests: settings.maxOpenRequests,
            organizationSuspended: standing.suspended,
            slots,
            minVisitLeadHours: settings.minVisitLeadHours,
            feeId,
            feeAmount: visitFeeAmount,
            paymentHours: settings.visitFeePaymentHours,
            walletDebited: false,
            now,
          }),
        );
        // Photos rattachées chez file au nom du client avant d'enregistrer leur référence (RV-102).
        for (const fileId of photoFileIds) {
          await this.deps.photos.attach({
            fileId,
            subject: { type: 'cleaning_request', id: requestId },
            ownerId: customer.userId,
          });
        }
        const offers = pricing ? await this.deps.offers.listOffers({ placeTypeId: placeType.id }) : [];
        const tariffs = new Map(
          (pricing?.pricing.offers ?? []).map((offer) => [offer.offerId, offer.tariffVersion]),
        );
        const publishedIds = pricing ? await this.tariffIds(offers.map((offer) => offer.id)) : new Map();
        const request: RequestRecord = {
          id: requestId,
          number: '',
          owner: customer.owner,
          submittedBy: customer.userId,
          placeId: place.id,
          placeTypeId: placeType.id,
          ...encryptLocation(this.deps.cipher, 'request', requestId, location, {
            commune: { key: place.communeKey, name: place.communeKey },
            boundariesVersion: place.communeBoundariesVersion,
          }),
          status: submitted.status,
          declaredValues: values,
          declaredRows: await this.rows(values),
          cleaningTypeIds,
          items: cleaningTypeIds
            .map((typeId) => {
              const offer = offers.find((item) => item.cleaningTypeId === typeId);
              const tariffVersionId =
                offer && tariffs.get(offer.id) !== null ? (publishedIds.get(offer.id) ?? null) : null;
              return { offerId: offer?.id ?? '', cleaningTypeId: typeId, tariffVersionId };
            })
            .filter((item) => item.offerId !== ''),
          schedulePlan,
          visitSlots: slots,
          pricingSnapshot: pricing ? pricing.pricing : null,
          estimatedSessionPrice: pricing?.pricing.complete ? pricing.pricing.sessionPrice : null,
          description,
          comment,
          photoFileIds,
          closingReason: null,
          closingReasonCode: null,
          closedAt: null,
          createdAt: now,
          updatedAt: now,
          version: 0,
        };
        const record: CaseRecord = {
          request,
          fees: [submitted.fee],
          visits: [],
          revisions: [],
          quotes: [],
          reactivations: [],
          programId: null,
          programNumber: null,
          programStatus: null,
        };
        const number = await this.deps.cases.insertCase(record, {
          changes: {
            events: [],
            audit: [
              audit(customer.userId, 'request.submitted', 'request', requestId, now, {
                placeId: place.id,
                visitFee: visitFeeAmount,
              }),
            ],
            idempotency: stub({ requestId }),
          },
        });
        return { requestId, fresh: true, number };
      },
    });

    const record = await this.deps.cases.findCase(created.requestId);
    if (!record) throw caseErrors.requestNotFound();
    if (!created.fresh) return record;
    // R-FV-02 : débit aussitôt ; l'issue (et l'annonce de la demande) est écrite après la réponse de
    // wallet. Une panne laisse l'opération en cours, reprise par la tâche des échéances.
    const fee = record.fees[0]!;
    const { record: settled } = await debitVisitFee(
      this.deps,
      record,
      fee,
      customer.userId ?? SYSTEM_ACTOR,
      now,
    );
    return settled;
  }

  /** Version publiée en vigueur de chaque offre (R-DM-03). */
  private async tariffIds(offerIds: readonly string[]): Promise<Map<string, string>> {
    const versions = await this.deps.offers.listTariffs(offerIds);
    return new Map(
      versions.filter((tariff) => tariff.status === 'published').map((tariff) => [tariff.offerId, tariff.id]),
    );
  }

  /** Lignes déclarées figées avec les libellés du catalogue du jour (RV-18). */
  private async rows(values: Record<string, ParameterValue>): Promise<DeclaredRow[]> {
    const parameters = await this.deps.parameters.listParameters();
    return Object.entries(values).map(([code, value]) => {
      const parameter = parameters.find((item) => item.code === code);
      return { parameterCode: code, label: parameter?.label ?? code, unit: parameter?.unit ?? null, value };
    });
  }
}
