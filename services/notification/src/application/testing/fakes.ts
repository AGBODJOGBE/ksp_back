/**
 * Doublures en mémoire des ports de l'application, pour les tests des cas d'usage.
 * Elles reproduisent les garanties du vrai dépôt (unicité de la clé d'idempotence) sans base de données.
 */
import { type ChannelName } from '../../domain/channel';
import { type FailureReason, type NotificationStatus } from '../../domain/delivery';
import {
  type ChannelProvider,
  type ClaimResult,
  type NewNotification,
  type NotificationFailedEvent,
  type NotificationRepository,
  type OutgoingMessage,
  type ProviderResult,
} from '../send/notification.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';

export interface NotificationRow extends NewNotification {
  status: NotificationStatus;
  channelUsed: ChannelName | null;
  channelsTried: ChannelName[];
  providerMessageId: string | null;
  errorCode: string | null;
  failureReason: FailureReason | null;
  acceptedAt: Date | null;
  failedAt: Date | null;
}

export class InMemoryNotifications implements NotificationRepository {
  readonly rows: NotificationRow[] = [];
  readonly events: NotificationFailedEvent[] = [];

  async claim(notification: NewNotification): Promise<ClaimResult> {
    const existing = this.rows.find((row) => row.idempotencyKey === notification.idempotencyKey);
    if (existing) {
      return {
        created: false,
        existing: {
          id: existing.id,
          status: existing.status,
          channelUsed: existing.channelUsed,
          channelsTried: existing.channelsTried,
          errorCode: existing.errorCode,
        },
      };
    }
    this.rows.push({
      ...notification,
      status: 'pending',
      channelUsed: null,
      channelsTried: [],
      providerMessageId: null,
      errorCode: null,
      failureReason: null,
      acceptedAt: null,
      failedAt: null,
    });
    return { created: true };
  }

  async markAccepted(
    id: string,
    accepted: { channelUsed: ChannelName; channelsTried: ChannelName[]; providerMessageId: string; at: Date },
  ): Promise<void> {
    const { at, ...rest } = accepted;
    Object.assign(this.row(id), { status: 'accepted', ...rest, acceptedAt: at });
  }

  async markFailed(
    id: string,
    failed: { channelsTried: ChannelName[]; reason: FailureReason; errorCode: string; at: Date },
    event: NotificationFailedEvent,
  ): Promise<void> {
    Object.assign(this.row(id), {
      status: 'failed',
      channelsTried: failed.channelsTried,
      failureReason: failed.reason,
      errorCode: failed.errorCode,
      failedAt: failed.at,
    });
    this.events.push(event);
  }

  private row(id: string): NotificationRow {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`notification ${id} inconnue`);
    return row;
  }
}

/** Prestataire scripté : rend les résultats prévus dans l'ordre, puis accepte. */
export class FakeProvider implements ChannelProvider {
  readonly sent: OutgoingMessage[] = [];

  constructor(
    readonly channel: ChannelName,
    /** Une fonction permet de simuler un effet pendant l'envoi (par exemple un prestataire lent). */
    private readonly results: (ProviderResult | Error | (() => ProviderResult))[] = [],
  ) {}

  async send(message: OutgoingMessage): Promise<ProviderResult> {
    this.sent.push(message);
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next ?? { accepted: true, providerMessageId: `${this.channel}-${this.sent.length}` };
  }
}

export class FixedClock implements Clock {
  constructor(public current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export class SequentialIds implements IdGenerator {
  private seq = 0;

  next(): string {
    this.seq += 1;
    return `0192f1c4-7a2b-7c3d-8e4f-${String(this.seq).padStart(12, '0')}`;
  }
}
