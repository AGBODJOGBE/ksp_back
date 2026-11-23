import { Injectable } from '@nestjs/common';
import { type Prisma } from '../../../prisma/generated';
import {
  type AuditLog,
  type CaseObligations,
  type FullSettings,
  type Holiday,
  type HolidayStore,
  type SettingsStore,
} from '../../application/ports';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';

const SETTINGS_ROW = 1;

/** Jour au Bénin « AAAA-MM-JJ » stocké en colonne DATE (minuit UTC du même jour). */
const toDateColumn = (day: string) => new Date(`${day}T00:00:00.000Z`);
const fromDateColumn = (date: Date) => date.toISOString().slice(0, 10);

/** Réglages du back-office : une seule ligne JSON, complétée par les valeurs par défaut à la lecture. */
@Injectable()
export class PrismaSettingsStore implements SettingsStore {
  constructor(private readonly prisma: PrismaService) {}

  async load(): Promise<{ values: unknown; updatedAt: Date; updatedBy: string | null } | null> {
    const row = await this.prisma.recoverySettingsRow.findUnique({ where: { id: SETTINGS_ROW } });
    return row ? { values: row.values, updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
  }

  async save(values: FullSettings, by: string, at: Date): Promise<void> {
    const json = values as unknown as Prisma.InputJsonValue;
    await this.prisma.recoverySettingsRow.upsert({
      where: { id: SETTINGS_ROW },
      create: { id: SETTINGS_ROW, values: json, updatedBy: by, updatedAt: at },
      update: { values: json, updatedBy: by, updatedAt: at },
    });
  }
}

@Injectable()
export class PrismaHolidayStore implements HolidayStore {
  constructor(private readonly prisma: PrismaService) {}

  async listYear(year: number): Promise<Holiday[]> {
    return this.between(`${year}-01-01`, `${year}-12-31`);
  }

  async replaceYear(year: number, holidays: readonly Holiday[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.holiday.deleteMany({
        where: { date: { gte: toDateColumn(`${year}-01-01`), lte: toDateColumn(`${year}-12-31`) } },
      }),
      this.prisma.holiday.createMany({
        data: holidays.map((holiday) => ({ date: toDateColumn(holiday.date), label: holiday.label })),
      }),
    ]);
  }

  async between(from: string, to: string): Promise<Holiday[]> {
    const rows = await this.prisma.holiday.findMany({
      where: { date: { gte: toDateColumn(from), lte: toDateColumn(to) } },
      orderBy: { date: 'asc' },
    });
    return rows.map((row) => ({ date: fromDateColumn(row.date), label: row.label }));
  }
}

/** Journal d'audit local (en attendant le service audit) : jamais de coordonnées de débiteur. */
@Injectable()
export class PrismaAuditLog implements AuditLog {
  private readonly ids = new UuidV7Generator();

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: Parameters<AuditLog['record']>[0]): Promise<void> {
    await this.prisma.auditEntry.create({
      data: {
        id: this.ids.next(),
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        at: new Date(),
        ...(entry.details ? { details: entry.details as Prisma.InputJsonValue } : {}),
      },
    });
  }
}

/** Dossiers qui bloquent la suppression d'un compte : en examen, actifs ou suspendus. */
const OPEN_STATUSES = ['under_review', 'info_requested', 'active', 'suspended'] as const;

@Injectable()
export class PrismaCaseObligations implements CaseObligations {
  constructor(private readonly prisma: PrismaService) {}

  async openCases(creditor: { type: 'user' | 'organization'; id: string }): Promise<{ number: string }[]> {
    return this.prisma.recoveryCase.findMany({
      where: { creditorType: creditor.type, creditorId: creditor.id, status: { in: [...OPEN_STATUSES] } },
      select: { number: true },
      orderBy: { sequence: 'asc' },
      take: 20,
    });
  }
}
