import { type Prisma } from '../../../../prisma/generated';
import {
  type Offer,
  type OfferRepository,
  type SaveMode,
  type TariffVersion,
} from '../../../application/catalog/catalog.ports';
import { type Changes, DuplicateKeyError, type IdGenerator } from '../../../application/ports';
import { type TeamRuleBracket } from '../../../domain/pricing/types';
import { type PrismaService } from '../../prisma/prisma.service';
import { json } from '../changes';
import { isUuid, transact } from './shared';

const offerInclude = {
  extraParameters: { orderBy: { position: 'asc' }, include: { parameter: { select: { code: true } } } },
} as const;

const tariffInclude = {
  baseParameter: { select: { code: true } },
  brackets: { orderBy: { fromValue: 'asc' } },
  supplements: { orderBy: { position: 'asc' }, include: { parameter: { select: { code: true } } } },
} as const;

type OfferRow = Prisma.OfferGetPayload<{ include: typeof offerInclude }>;
type TariffRow = Prisma.TariffVersionGetPayload<{ include: typeof tariffInclude }>;

/** Règle d'équipe en base : noms du contrat TeamRuleBracket (fromArea, toArea, agents, durationMinutes). */
const toOffer = (row: OfferRow): Offer => ({
  id: row.id,
  placeTypeId: row.placeTypeId,
  cleaningTypeId: row.cleaningTypeId,
  extraParameters: row.extraParameters.map((link) => ({
    parameterId: link.parameterId,
    code: link.parameter.code,
  })),
  teamRule: (row.teamRule as unknown as TeamRuleBracket[]).map((bracket) => ({
    fromArea: bracket.fromArea,
    toArea: bracket.toArea,
    agents: bracket.agents,
    durationMinutes: bracket.durationMinutes,
  })),
  order: row.displayOrder,
  active: row.active,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

const toTariff = (row: TariffRow): TariffVersion => ({
  id: row.id,
  offerId: row.offerId,
  version: row.version,
  status: row.status,
  baseParameterId: row.baseParameterId,
  baseParameterCode: row.baseParameter?.code ?? null,
  brackets: row.brackets.map((bracket) => ({
    from: bracket.fromValue,
    to: bracket.toValue,
    mode: bracket.mode,
    amount: bracket.amount,
  })),
  supplements: row.supplements.map((supplement) => ({
    parameterId: supplement.parameterId,
    parameterCode: supplement.parameter.code,
    choiceCode: supplement.choiceCode,
    mode: supplement.mode,
    amount: supplement.amount,
    coefficientBps: supplement.coefficientBp,
    includedUnits: supplement.includedUnits,
  })),
  minimum: row.minimumPrice,
  frequencyCoefficients: Object.entries(row.frequencyCoefficients as Record<string, number>).map(
    ([key, coefficientBps]) => ({ key, coefficientBps }),
  ),
  packDiscountBps: row.packDiscountBp,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  publishedAt: row.publishedAt,
  publishedBy: row.publishedBy,
});

/**
 * Offres et versions de tarif (R-CA-03, R-CA-07, R-CA-08) : une offre par lieu et type, une seule
 * version publiée par offre (index partiel), une version publiée jamais modifiée.
 */
export class PrismaOfferRepository implements OfferRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async listOffers(filter: { placeTypeId?: string; cleaningTypeId?: string } = {}): Promise<Offer[]> {
    if (
      (filter.placeTypeId && !isUuid(filter.placeTypeId)) ||
      (filter.cleaningTypeId && !isUuid(filter.cleaningTypeId))
    ) {
      return [];
    }
    const rows = await this.prisma.offer.findMany({
      where: {
        ...(filter.placeTypeId ? { placeTypeId: filter.placeTypeId } : {}),
        ...(filter.cleaningTypeId ? { cleaningTypeId: filter.cleaningTypeId } : {}),
      },
      include: offerInclude,
    });
    return rows.map(toOffer);
  }

  async getOffer(id: string): Promise<Offer | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.offer.findUnique({ where: { id }, include: offerInclude });
    return row && toOffer(row);
  }

  /** Une seule offre par lieu et type : le couple déjà pris répond « code déjà utilisé ». */
  async saveOffer(offer: Offer, mode: SaveMode, changes: Changes): Promise<void> {
    const data = {
      teamRule: json(offer.teamRule),
      displayOrder: offer.order,
      active: offer.active,
      updatedAt: offer.updatedAt,
      updatedBy: offer.updatedBy,
    };
    await transact(
      this.prisma,
      this.ids,
      changes,
      async (tx) => {
        if (mode === 'create') {
          await tx.offer.create({
            data: {
              ...data,
              id: offer.id,
              placeTypeId: offer.placeTypeId,
              cleaningTypeId: offer.cleaningTypeId,
              createdAt: offer.createdAt,
            },
          });
        } else {
          await tx.offer.update({ where: { id: offer.id }, data });
          await tx.offerParameter.deleteMany({ where: { offerId: offer.id } });
        }
        await tx.offerParameter.createMany({
          data: offer.extraParameters.map((link, position) => ({
            offerId: offer.id,
            parameterId: link.parameterId,
            position,
          })),
        });
      },
      ['place_type_id', 'placeTypeId'],
    );
  }

  async listTariffs(offerIds: readonly string[]): Promise<TariffVersion[]> {
    const ids = offerIds.filter(isUuid);
    if (!ids.length) return [];
    const rows = await this.prisma.tariffVersion.findMany({
      where: { offerId: { in: ids } },
      include: tariffInclude,
      orderBy: [{ offerId: 'asc' }, { version: 'desc' }],
    });
    return rows.map(toTariff);
  }

  async getTariffsByIds(ids: readonly string[]): Promise<TariffVersion[]> {
    const valid = ids.filter(isUuid);
    if (!valid.length) return [];
    return (
      await this.prisma.tariffVersion.findMany({ where: { id: { in: valid } }, include: tariffInclude })
    ).map(toTariff);
  }

  /** Brouillon écrit en entier : tranches et suppléments remplacés. Version déjà prise : concurrence. */
  async saveDraft(tariff: TariffVersion, mode: SaveMode, changes: Changes): Promise<void> {
    const data = {
      baseParameterId: tariff.baseParameterId,
      packDiscountBp: tariff.packDiscountBps,
      minimumPrice: tariff.minimum,
      frequencyCoefficients: json(
        Object.fromEntries(tariff.frequencyCoefficients.map((entry) => [entry.key, entry.coefficientBps])),
      ),
    };
    await transact(
      this.prisma,
      this.ids,
      changes,
      async (tx) => {
        if (mode === 'create') {
          await tx.tariffVersion.create({
            data: {
              ...data,
              id: tariff.id,
              offerId: tariff.offerId,
              version: tariff.version,
              status: 'draft',
              createdAt: tariff.createdAt,
              createdBy: tariff.createdBy,
            },
          });
        } else {
          const updated = await tx.tariffVersion.updateMany({
            where: { id: tariff.id, status: 'draft' },
            data,
          });
          if (updated.count !== 1) throw new DuplicateKeyError('concurrent');
          await tx.tariffBracket.deleteMany({ where: { tariffVersionId: tariff.id } });
          await tx.tariffSupplement.deleteMany({ where: { tariffVersionId: tariff.id } });
        }
        await tx.tariffBracket.createMany({
          data: tariff.brackets.map((bracket) => ({
            id: this.ids.next(),
            tariffVersionId: tariff.id,
            fromValue: bracket.from,
            toValue: bracket.to,
            mode: bracket.mode,
            amount: bracket.amount,
          })),
        });
        await tx.tariffSupplement.createMany({
          data: tariff.supplements.map((supplement, position) => ({
            id: this.ids.next(),
            tariffVersionId: tariff.id,
            parameterId: supplement.parameterId,
            choiceCode: supplement.choiceCode,
            mode: supplement.mode,
            amount: supplement.amount,
            coefficientBp: supplement.coefficientBps,
            includedUnits: supplement.includedUnits,
            position,
          })),
        });
      },
      [],
    );
  }

  /**
   * Publication : la version publiée précédente est archivée d'abord (une seule version publiée par
   * offre), puis le brouillon publié. Un état changé entre-temps : écriture concurrente.
   */
  async publish(input: {
    tariffId: string;
    previousPublishedId: string | null;
    at: Date;
    by: string;
    changes: Changes;
  }): Promise<void> {
    await transact(
      this.prisma,
      this.ids,
      input.changes,
      async (tx) => {
        if (input.previousPublishedId) {
          const archived = await tx.tariffVersion.updateMany({
            where: { id: input.previousPublishedId, status: 'published' },
            data: { status: 'archived', archivedAt: input.at },
          });
          if (archived.count !== 1) throw new DuplicateKeyError('concurrent');
        }
        const published = await tx.tariffVersion.updateMany({
          where: { id: input.tariffId, status: 'draft' },
          data: { status: 'published', publishedAt: input.at, publishedBy: input.by },
        });
        if (published.count !== 1) throw new DuplicateKeyError('concurrent');
      },
      [],
    );
  }
}
