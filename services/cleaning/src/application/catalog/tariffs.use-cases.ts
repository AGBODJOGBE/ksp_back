import { type TariffProblem, tariffProblems, type TariffStage } from '../../domain/pricing/tariff-validation';
import { type BracketMode, type SupplementMode } from '../../domain/pricing/types';
import { type CleaningDeps } from '../deps';
import { DuplicateKeyError } from '../ports';
import { requireStaff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { type Page, pageOf, parsePage, parseSort } from '../shared/paging';
import { type Offer, type Parameter, type TariffVersion } from './catalog.ports';
import { type PageInput } from './places.use-cases';

/**
 * UC-NT-28 — Tarifs par tranches d'une offre (R-CA-04, R-CA-07, R-CA-08, R-CA-11) : un brouillon à
 * la fois (version suivante), modifiable par PUT ; publié, il remplace la version en vigueur, qui est
 * archivée. Une version publiée ne change plus. Cohérence contrôlée par le domaine au brouillon et à
 * la publication. Base absente d'un tarif par tranches : la superficie du lieu (R-CA-14).
 */
const BRACKET_MODES: readonly BracketMode[] = ['flat', 'per_unit'];
const SUPPLEMENT_MODES: readonly SupplementMode[] = ['fixed', 'per_unit', 'coefficient'];

export interface TariffFields {
  baseParameterCode?: string | undefined;
  brackets: { from: number; to: number; mode: string; amount?: number | undefined }[];
  supplements: {
    parameterCode: string;
    choiceCode?: string | undefined;
    mode: string;
    amount?: number | undefined;
    coefficientBps?: number | undefined;
    includedUnits?: number | undefined;
  }[];
  minimum?: number | undefined;
  frequencyCoefficients: { key: string; coefficientBps: number }[];
  packDiscountBps?: number | undefined;
}

/** Premier défaut du domaine traduit en erreur du contrat. */
function throwTariffProblem(problems: readonly TariffProblem[]): void {
  const first = problems[0];
  if (!first) return;
  if (first.code === 'CLEANING_TARIFF_INCOMPLETE')
    throw CleaningErrors.tariffIncomplete(first.reason, first.index);
  throw CleaningErrors.validation(first.field, first.reason);
}

export class TariffsUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: PageInput & { offerId: string }): Promise<Page<TariffVersion>> {
    requireStaff();
    const page = parsePage(input);
    parseSort(input.sort, ['-version']);
    await this.offer(input.offerId);
    return pageOf(await this.deps.offers.listTariffs([input.offerId]), page);
  }

  async createDraft(
    input: TariffFields & { offerId: string; idempotencyKey: string },
  ): Promise<TariffVersion> {
    const { userId } = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.tariff.create_draft',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.tariff(input.offerId, Number(response.version)),
      run: async (stub) => {
        const offer = await this.offer(input.offerId);
        const versions = await this.deps.offers.listTariffs([offer.id]);
        const draft = versions.find((tariff) => tariff.status === 'draft');
        if (draft) throw CleaningErrors.invalidTransition('draft', 'draft');
        const tariff = await this.build(offer, input, {
          id: this.deps.ids.next(),
          version: Math.max(0, ...versions.map((tariff) => tariff.version)) + 1,
          createdAt: now,
          createdBy: userId,
        });
        await this.saveDraft(tariff, 'create', userId, now, stub({ id: tariff.id, version: tariff.version }));
        return tariff;
      },
    });
  }

  async updateDraft(input: TariffFields & { offerId: string; version: number }): Promise<TariffVersion> {
    const { userId } = requireStaff();
    const offer = await this.offer(input.offerId);
    const current = await this.tariff(offer.id, input.version);
    if (current.status !== 'draft') throw CleaningErrors.invalidTransition(current.status, 'draft');
    const tariff = await this.build(offer, input, current);
    await this.saveDraft(tariff, 'update', userId, this.deps.clock.now());
    return tariff;
  }

  /**
   * Publication (R-CA-08) : tarif contrôlé au stade « publication », version précédente archivée.
   * Rejouée par son auteur sur une version déjà publiée : état courant, sans nouvelle trace.
   */
  async publish(input: { offerId: string; version: number; idempotencyKey: string }): Promise<TariffVersion> {
    const { userId } = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.tariff.publish',
      key: idempotencyKey,
      body,
      at: now,
      replay: () => this.tariff(input.offerId, input.version),
      run: async (stub) => {
        const offer = await this.offer(input.offerId);
        const tariff = await this.tariff(offer.id, input.version);
        if (tariff.status === 'published' && tariff.publishedBy === userId) return tariff;
        if (tariff.status !== 'draft') throw CleaningErrors.invalidTransition(tariff.status, 'published');
        const { asked, isPack } = await this.context(offer);
        throwTariffProblem(tariffProblems(tariff, { askedParameters: asked, isPack }, 'publish'));
        const previous = (await this.deps.offers.listTariffs([offer.id])).find(
          (other) => other.status === 'published',
        );
        const audit = [
          {
            actorId: userId,
            action: 'catalog.tariff.published',
            entityType: 'tariff',
            entityId: tariff.id,
            at: now,
            details: {
              offerId: offer.id,
              version: tariff.version,
              previousVersion: previous?.version ?? null,
            },
          },
          ...(previous
            ? [
                {
                  actorId: userId,
                  action: 'catalog.tariff.archived',
                  entityType: 'tariff',
                  entityId: previous.id,
                  at: now,
                  details: { offerId: offer.id, version: previous.version, replacedBy: tariff.version },
                },
              ]
            : []),
        ];
        try {
          await this.deps.offers.publish({
            tariffId: tariff.id,
            previousPublishedId: previous?.id ?? null,
            at: now,
            by: userId,
            changes: { events: [], audit, idempotency: stub({ id: tariff.id }) },
          });
        } catch (error) {
          if (error instanceof DuplicateKeyError && error.key === 'concurrent')
            throw CleaningErrors.concurrentUpdate();
          throw error;
        }
        return { ...tariff, status: 'published', publishedAt: now, publishedBy: userId };
      },
    });
  }

  private async offer(id: string): Promise<Offer> {
    const offer = await this.deps.offers.getOffer(id);
    if (!offer) throw CleaningErrors.offerNotFound();
    return offer;
  }

  private async tariff(offerId: string, version: number): Promise<TariffVersion> {
    const tariff = (await this.deps.offers.listTariffs([offerId])).find(
      (candidate) => candidate.version === version,
    );
    if (!tariff) throw CleaningErrors.tariffNotFound();
    return tariff;
  }

  /** Paramètres demandés par le lieu et l'offre (R-CA-11), et nature pack du type (R-CA-04). */
  private async context(
    offer: Offer,
  ): Promise<{ asked: Parameter[]; isPack: boolean; all: Parameter[]; areaCode: string | null }> {
    const [placeType, type, all] = await Promise.all([
      this.deps.places.getPlaceType(offer.placeTypeId),
      this.deps.cleaningTypes.getCleaningType(offer.cleaningTypeId),
      this.deps.parameters.listParameters(),
    ]);
    const askedIds = new Set([
      ...(placeType?.parameters ?? []).map((link) => link.parameterId),
      ...offer.extraParameters.map((link) => link.parameterId),
    ]);
    const areaCode = all.find((parameter) => parameter.id === placeType?.areaParameterId)?.code ?? null;
    return {
      asked: all.filter((parameter) => askedIds.has(parameter.id)),
      isPack: type?.isPack ?? false,
      all,
      areaCode,
    };
  }

  /** Tarif saisi → version enregistrable, après contrôle des natures, des paramètres et du domaine. */
  private async build(
    offer: Offer,
    input: TariffFields,
    identity: Pick<TariffVersion, 'id' | 'version' | 'createdAt' | 'createdBy'>,
  ): Promise<TariffVersion> {
    const { asked, isPack, all, areaCode } = await this.context(offer);
    const byCode = new Map(all.map((parameter) => [parameter.code, parameter]));
    const idOf = (code: string) => {
      const parameter = byCode.get(code);
      if (!parameter) throw CleaningErrors.parameterNotFound({ parameterCode: code });
      return parameter.id;
    };
    const packDiscountBps = input.packDiscountBps ?? null;
    const baseParameterCode = input.baseParameterCode ?? (packDiscountBps === null ? areaCode : null);
    input.brackets.forEach((bracket, index) => {
      if (!BRACKET_MODES.includes(bracket.mode as BracketMode)) {
        throw CleaningErrors.validation(`brackets[${index}].mode`, 'invalid_type');
      }
      if (bracket.amount === undefined)
        throw CleaningErrors.validation(`brackets[${index}].amount`, 'required');
    });
    input.supplements.forEach((supplement, index) => {
      if (!SUPPLEMENT_MODES.includes(supplement.mode as SupplementMode)) {
        throw CleaningErrors.validation(`supplements[${index}].mode`, 'invalid_type');
      }
    });
    if (input.minimum === undefined) throw CleaningErrors.validation('minimum', 'required');
    const tariff: TariffVersion = {
      ...identity,
      offerId: offer.id,
      status: 'draft',
      baseParameterId: baseParameterCode === null ? null : idOf(baseParameterCode),
      baseParameterCode,
      brackets: input.brackets.map((bracket) => ({
        from: bracket.from,
        to: bracket.to,
        mode: bracket.mode as BracketMode,
        amount: bracket.amount as number,
      })),
      supplements: input.supplements.map((supplement) => ({
        parameterId: idOf(supplement.parameterCode),
        parameterCode: supplement.parameterCode,
        choiceCode: supplement.choiceCode ?? null,
        mode: supplement.mode as SupplementMode,
        amount: supplement.amount ?? null,
        coefficientBps: supplement.coefficientBps ?? null,
        includedUnits: supplement.includedUnits ?? 0,
      })),
      minimum: input.minimum,
      frequencyCoefficients: input.frequencyCoefficients.map((entry) => ({ ...entry })),
      packDiscountBps,
      publishedAt: null,
      publishedBy: null,
    };
    throwTariffProblem(
      tariffProblems(tariff, { askedParameters: asked, isPack }, 'draft' satisfies TariffStage),
    );
    return tariff;
  }

  private async saveDraft(
    tariff: TariffVersion,
    mode: 'create' | 'update',
    userId: string,
    at: Date,
    idempotency?: Parameters<CleaningDeps['offers']['saveDraft']>[2]['idempotency'],
  ): Promise<void> {
    const audit = {
      actorId: userId,
      action: 'catalog.tariff.draft_saved',
      entityType: 'tariff',
      entityId: tariff.id,
      at,
      details: {
        offerId: tariff.offerId,
        version: tariff.version,
        baseParameterCode: tariff.baseParameterCode,
        brackets: tariff.brackets,
        supplements: tariff.supplements.map(({ parameterId: _id, ...supplement }) => supplement),
        minimum: tariff.minimum,
        frequencyCoefficients: tariff.frequencyCoefficients,
        packDiscountBps: tariff.packDiscountBps,
      },
    };
    try {
      await this.deps.offers.saveDraft(tariff, mode, {
        events: [],
        audit: [audit],
        ...(idempotency ? { idempotency } : {}),
      });
    } catch (error) {
      if (error instanceof DuplicateKeyError && error.key === 'concurrent')
        throw CleaningErrors.concurrentUpdate();
      throw error;
    }
  }
}
