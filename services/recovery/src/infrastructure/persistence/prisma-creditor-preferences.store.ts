import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import {
  type CreditorPreferences,
  type CreditorPreferencesStore,
  type StoredCreditorPreferences,
} from '../../application/cases/ports';
import { type Holder } from '../../application/ports';
import { type PlanScale } from '../../domain/payment-plan';
import { PrismaService } from '../prisma/prisma.service';
import { json } from './prisma-case-rows';

/** Préférences des créanciers : une ligne par compte ou organisation. */
@Injectable()
export class PrismaCreditorPreferencesStore implements CreditorPreferencesStore {
  constructor(private readonly prisma: PrismaService) {}

  async get(creditor: Holder): Promise<StoredCreditorPreferences | null> {
    const row = await this.prisma.creditorPreference.findUnique({
      where: { creditorType_creditorId: { creditorType: creditor.type, creditorId: creditor.id } },
    });
    if (!row) return null;
    return {
      b2bScale: (row.b2bScale as PlanScale | null) ?? null,
      b2cScale: (row.b2cScale as PlanScale | null) ?? null,
      notifyUserIds: row.notifyUserIds,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async save(creditor: Holder, preferences: CreditorPreferences, by: string, at: Date): Promise<void> {
    const values = {
      b2bScale: preferences.b2bScale ? json(preferences.b2bScale) : Prisma.DbNull,
      b2cScale: preferences.b2cScale ? json(preferences.b2cScale) : Prisma.DbNull,
      notifyUserIds: preferences.notifyUserIds,
      updatedAt: at,
      updatedBy: by,
    };
    await this.prisma.creditorPreference.upsert({
      where: { creditorType_creditorId: { creditorType: creditor.type, creditorId: creditor.id } },
      create: { creditorType: creditor.type, creditorId: creditor.id, ...values },
      update: values,
    });
  }
}
