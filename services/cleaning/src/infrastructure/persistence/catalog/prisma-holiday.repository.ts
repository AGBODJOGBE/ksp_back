import { type Holiday, type HolidayRepository } from '../../../application/catalog/catalog.ports';
import { type Changes, DuplicateKeyError, type IdGenerator } from '../../../application/ports';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid, transact } from './shared';

const toDay = (date: Date) => date.toISOString().slice(0, 10);
const fromDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * Jours fériés nationaux (R-PG-02), un par date. Retirer un jour le désactive (sa ligne garde la date
 * unique) ; le rajouter à la même date reprend la ligne.
 */
export class PrismaHolidayRepository implements HolidayRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async listHolidays(year?: number): Promise<Holiday[]> {
    const rows = await this.prisma.publicHoliday.findMany({
      where: {
        active: true,
        ...(year ? { date: { gte: fromDay(`${year}-01-01`), lt: fromDay(`${year + 1}-01-01`) } } : {}),
      },
      orderBy: { date: 'asc' },
    });
    return rows.map((row) => ({ id: row.id, date: toDay(row.date), name: row.name }));
  }

  async getHoliday(id: string): Promise<Holiday | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.publicHoliday.findFirst({ where: { id, active: true } });
    return row && { id: row.id, date: toDay(row.date), name: row.name };
  }

  async addHoliday(holiday: Holiday, at: Date, by: string, changes: Changes): Promise<Holiday> {
    let kept = holiday;
    await transact(
      this.prisma,
      this.ids,
      changes,
      async (tx) => {
        const date = fromDay(holiday.date);
        const existing = await tx.publicHoliday.findUnique({ where: { date } });
        if (existing?.active) throw new DuplicateKeyError('code');
        if (existing) {
          kept = { ...holiday, id: existing.id };
          await tx.publicHoliday.update({
            where: { id: existing.id },
            data: { name: holiday.name, active: true, updatedAt: at, updatedBy: by },
          });
        } else {
          await tx.publicHoliday.create({
            data: { id: holiday.id, date, name: holiday.name, active: true, updatedAt: at, updatedBy: by },
          });
        }
      },
      ['date'],
    );
    return kept;
  }

  async removeHoliday(id: string, at: Date, by: string, changes: Changes): Promise<void> {
    await transact(this.prisma, this.ids, changes, (tx) =>
      tx.publicHoliday.update({ where: { id }, data: { active: false, updatedAt: at, updatedBy: by } }),
    );
  }
}
