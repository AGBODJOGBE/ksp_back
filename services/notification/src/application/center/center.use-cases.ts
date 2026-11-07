import { type ChannelName } from '../../domain/channel';
import { type TemplatePreview, templateCatalog } from '../../domain/catalog';
import { type NotificationStatus } from '../../domain/delivery';
import { dayStart, nextDayStart } from '../../domain/period';
import { type Clock } from '../shared/system.ports';
import {
  CenterErrors,
  currentUserId,
  optionalUuid,
  parsePage,
  requireNotificationStaff,
  requireUuid,
} from './center.access';
import {
  type DeliveryFilters,
  type DeliveryHistory,
  type DeliveryRecord,
  type InAppNotificationStore,
  type PageResult,
  type PreferencesStore,
  type StoredInAppNotification,
  type StoredPreferences,
} from './center.ports';

type PageInput = { limit?: number; cursor?: string } | undefined;

// --- Notifications de l'espace KSP (l'utilisateur connecté, lui seul) ------------------------------

export interface MyNotificationsPage extends PageResult<StoredInAppNotification> {
  unreadCount: number;
}

/** Les notifications du compte, les plus récentes d'abord ; nombre de non lues pour la pastille. */
export class ListMyNotificationsUseCase {
  constructor(private readonly store: InAppNotificationStore) {}

  async execute(input: { page: PageInput; unreadOnly: boolean }): Promise<MyNotificationsPage> {
    const userId = currentUserId();
    const page = parsePage(input.page);
    const [result, unreadCount] = await Promise.all([
      this.store.list(userId, page, { unreadOnly: input.unreadOnly }),
      this.store.countUnread(userId),
    ]);
    return { ...result, unreadCount };
  }
}

export class CountMyUnreadNotificationsUseCase {
  constructor(private readonly store: InAppNotificationStore) {}

  execute(): Promise<number> {
    return this.store.countUnread(currentUserId());
  }
}

/** Idempotent : une notification déjà lue garde sa première date de lecture. */
export class MarkNotificationReadUseCase {
  constructor(
    private readonly store: InAppNotificationStore,
    private readonly clock: Clock,
  ) {}

  async execute(
    notificationId: string,
  ): Promise<{ notification: StoredInAppNotification; unreadCount: number }> {
    const userId = currentUserId();
    const id = requireUuid('notificationId', notificationId);
    const notification = await this.store.markRead(userId, id, this.clock.now());
    if (!notification) throw CenterErrors.notFound();
    return { notification, unreadCount: await this.store.countUnread(userId) };
  }
}

export class MarkAllNotificationsReadUseCase {
  constructor(
    private readonly store: InAppNotificationStore,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<{ marked: number; unreadCount: number }> {
    const userId = currentUserId();
    const marked = await this.store.markAllRead(userId, this.clock.now());
    return { marked, unreadCount: await this.store.countUnread(userId) };
  }
}

// --- Préférences de canaux (ADR-038) --------------------------------------------------------------

export class GetMyNotificationPreferencesUseCase {
  constructor(private readonly preferences: PreferencesStore) {}

  execute(): Promise<StoredPreferences> {
    return this.preferences.get(currentUserId());
  }
}

/**
 * Canaux souhaités pour les messages facultatifs. Tout écarter est permis : les messages restent
 * dans l'espace KSP, et les messages importants partent toujours.
 */
export class UpdateMyNotificationPreferencesUseCase {
  constructor(
    private readonly preferences: PreferencesStore,
    private readonly clock: Clock,
  ) {}

  execute(input: { whatsapp: boolean; email: boolean }): Promise<StoredPreferences> {
    return this.preferences.save(
      currentUserId(),
      { whatsapp: input.whatsapp === true, email: input.email === true },
      this.clock.now(),
    );
  }
}

// --- Back-office : historique des envois et modèles ----------------------------------------------

const CHANNELS: readonly ChannelName[] = ['sms', 'whatsapp', 'email', 'push', 'in_app'];
const STATUSES: readonly NotificationStatus[] = ['pending', 'accepted', 'failed'];
const TEMPLATE_CODE = /^[a-z][a-z0-9_.]{0,99}$/;

export interface DeliveryFilterInput {
  templateCode?: string;
  channel?: string;
  status?: string;
  /** Dates AAAA-MM-JJ à l'heure du Bénin, bornes incluses ; chaîne vide = absente. */
  from?: string;
  to?: string;
  recipientUserId?: string;
}

function oneOf<T extends string>(field: string, value: string | undefined, allowed: readonly T[]): T | null {
  if (!value) return null;
  if (!allowed.includes(value as T)) throw CenterErrors.invalid(field);
  return value as T;
}

/** Historique des envois, filtré, les plus récents d'abord. Aucune donnée personnelle en clair. */
export class ListDeliveriesUseCase {
  constructor(
    private readonly history: DeliveryHistory,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {}

  execute(input: { page: PageInput; filters: DeliveryFilterInput }): Promise<PageResult<DeliveryRecord>> {
    requireNotificationStaff(this.clock.now().getTime());
    const page = parsePage(input.page);
    const { filters } = input;
    if (filters.templateCode && !TEMPLATE_CODE.test(filters.templateCode)) {
      throw CenterErrors.invalid('templateCode');
    }
    const from = filters.from ? dayStart(filters.from, this.timeZone) : null;
    if (filters.from && !from) throw CenterErrors.invalid('from', 'Date attendue au format AAAA-MM-JJ.');
    const to = filters.to ? nextDayStart(filters.to, this.timeZone) : null;
    if (filters.to && !to) throw CenterErrors.invalid('to', 'Date attendue au format AAAA-MM-JJ.');
    if (from && to && to.getTime() <= from.getTime()) {
      throw CenterErrors.invalid('to', 'La fin de la période précède son début.');
    }
    const parsed: DeliveryFilters = {
      templateCode: filters.templateCode || null,
      channel: oneOf('channel', filters.channel, CHANNELS),
      status: oneOf('status', filters.status, STATUSES),
      from,
      to,
      recipientUserId: optionalUuid('recipientUserId', filters.recipientUserId),
    };
    return this.history.list(parsed, page);
  }
}

export class GetDeliveryUseCase {
  constructor(
    private readonly history: DeliveryHistory,
    private readonly clock: Clock,
  ) {}

  async execute(deliveryId: string): Promise<DeliveryRecord> {
    requireNotificationStaff(this.clock.now().getTime());
    const delivery = await this.history.find(requireUuid('deliveryId', deliveryId));
    if (!delivery) throw CenterErrors.notFound();
    return delivery;
  }
}

/** Modèles de messages et leur texte, rendu avec le nom des variables (lecture seule). */
export class ListMessageTemplatesUseCase {
  constructor(private readonly clock: Clock) {}

  execute(): TemplatePreview[] {
    requireNotificationStaff(this.clock.now().getTime());
    return templateCatalog();
  }
}
