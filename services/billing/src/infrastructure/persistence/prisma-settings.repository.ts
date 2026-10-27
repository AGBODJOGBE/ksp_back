import { Injectable } from '@nestjs/common';
import { type SettingsRepository, type StoredBillingSettings } from '../../application/ports';
import { type BillingSettings, DEFAULT_BILLING_SETTINGS } from '../../domain/settings';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaSettingsRepository implements SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<StoredBillingSettings> {
    const row = await this.prisma.billingSettings.findUnique({ where: { id: 1 } });
    if (!row) return { ...DEFAULT_BILLING_SETTINGS, updatedBy: null, updatedAt: null };
    return { paymentTermDays: row.paymentTermDays, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
  }

  async save(settings: BillingSettings, updatedBy: string, at: Date): Promise<StoredBillingSettings> {
    const values = { paymentTermDays: settings.paymentTermDays, updatedBy, updatedAt: at };
    await this.prisma.billingSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...values },
      update: values,
    });
    return values;
  }
}
