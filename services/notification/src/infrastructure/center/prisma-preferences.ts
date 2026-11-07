import { Injectable } from '@nestjs/common';
import { type PreferencesStore, type StoredPreferences } from '../../application/center/center.ports';
import { type ChannelPreferences, DEFAULT_CHANNEL_PREFERENCES } from '../../domain/preferences';
import { PrismaService } from '../prisma/prisma.service';

/** Préférences de canaux (table notification_preferences, ADR-038). */
@Injectable()
export class PrismaPreferences implements PreferencesStore {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<StoredPreferences> {
    const row = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    return row
      ? { whatsapp: row.whatsapp, email: row.email, updatedAt: row.updatedAt }
      : { ...DEFAULT_CHANNEL_PREFERENCES, updatedAt: null };
  }

  async save(userId: string, preferences: ChannelPreferences, at: Date): Promise<StoredPreferences> {
    const data = { whatsapp: preferences.whatsapp, email: preferences.email, updatedAt: at };
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return { whatsapp: row.whatsapp, email: row.email, updatedAt: row.updatedAt };
  }

  async findMany(userIds: readonly string[]): Promise<Map<string, ChannelPreferences>> {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: [...userIds] } },
    });
    return new Map(rows.map((row) => [row.userId, { whatsapp: row.whatsapp, email: row.email }]));
  }
}
