import { type Prisma } from '../../../../prisma/generated';
import {
  type Parameter,
  type ParameterRepository,
  type SaveMode,
} from '../../../application/catalog/catalog.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import { type ChoiceEntry } from '../../../domain/catalog/entries';
import { type PrismaService } from '../../prisma/prisma.service';
import { json } from '../changes';
import { isUuid, optional, transact } from './shared';

type ParameterRow = Prisma.ParameterGetPayload<object>;

const toParameter = (row: ParameterRow): Parameter => ({
  id: row.id,
  code: row.code,
  label: row.label,
  kind: row.kind,
  unit: row.unit,
  min: row.minValue,
  max: row.maxValue,
  choices: (row.choices as unknown as ChoiceEntry[]).map((choice) => ({
    code: choice.code,
    label: choice.label,
    active: choice.active,
  })),
  required: row.required,
  help: optional(row.help),
  active: row.active,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

/** Paramètres demandés au client (R-CA-01, R-CA-02) : la nature ne change jamais après la création. */
export class PrismaParameterRepository implements ParameterRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async listParameters(): Promise<Parameter[]> {
    return (await this.prisma.parameter.findMany()).map(toParameter);
  }

  async getParameter(id: string): Promise<Parameter | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.parameter.findUnique({ where: { id } });
    return row && toParameter(row);
  }

  async saveParameter(parameter: Parameter, mode: SaveMode, changes: Changes): Promise<void> {
    const data = {
      label: parameter.label,
      unit: parameter.unit,
      minValue: parameter.min,
      maxValue: parameter.max,
      choices: json(parameter.choices),
      required: parameter.required,
      help: parameter.help ?? '',
      active: parameter.active,
      updatedAt: parameter.updatedAt,
      updatedBy: parameter.updatedBy,
    };
    await transact(this.prisma, this.ids, changes, (tx) =>
      mode === 'create'
        ? tx.parameter.create({
            data: {
              ...data,
              id: parameter.id,
              code: parameter.code,
              kind: parameter.kind,
              createdAt: parameter.updatedAt,
            },
          })
        : tx.parameter.update({ where: { id: parameter.id }, data }),
    );
  }

  /** Offres dont le tarif publié cite le paramètre (base ou supplément), lieux actifs qui le demandent. */
  async usageOf(parameterId: string): Promise<{ offerIds: string[]; placeTypeIds: string[] }> {
    const [tariffs, placeTypes] = await Promise.all([
      this.prisma.tariffVersion.findMany({
        where: {
          status: 'published',
          OR: [{ baseParameterId: parameterId }, { supplements: { some: { parameterId } } }],
        },
        select: { offerId: true },
        orderBy: { offerId: 'asc' },
      }),
      this.prisma.placeType.findMany({
        where: {
          active: true,
          OR: [{ areaParameterId: parameterId }, { parameters: { some: { parameterId } } }],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return {
      offerIds: [...new Set(tariffs.map((tariff) => tariff.offerId))],
      placeTypeIds: placeTypes.map((placeType) => placeType.id),
    };
  }
}
