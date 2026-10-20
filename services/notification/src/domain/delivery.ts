import { type ChannelName } from './channel';

/** Cause d'un échec, telle que publiée dans notification.message.failed. */
export type FailureReason =
  'provider_unavailable' | 'provider_rejected' | 'recipient_invalid' | 'ttl_expired';

/** Cause d'un échec rapportée par un prestataire. */
export type ProviderFailureReason = Exclude<FailureReason, 'ttl_expired'>;

export type NotificationStatus = 'pending' | 'accepted' | 'failed';

/**
 * Sort d'un canal : sauté (aucun prestataire configuré, par exemple le SMS au lancement, ADR-021)
 * ou refusé par le prestataire.
 */
export type ChannelAttempt =
  | { channel: ChannelName; outcome: 'skipped' }
  | { channel: ChannelName; outcome: 'failed'; reason: ProviderFailureReason };

/** Date au-delà de laquelle le message n'est plus envoyé ; null si l'appelant n'a pas fixé de limite (0). */
export function expiryOf(createdAt: Date, ttlSeconds: number): Date | null {
  return ttlSeconds > 0 ? new Date(createdAt.getTime() + ttlSeconds * 1000) : null;
}

export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && now.getTime() >= expiresAt.getTime();
}

export interface DeliveryFailure {
  /** Canaux considérés, dans l'ordre (sautés compris). */
  channelsTried: ChannelName[];
  reason: FailureReason;
  /**
   * Vrai si chaque prestataire réellement appelé a refusé le destinataire (par exemple un numéro
   * sans WhatsApp) : l'appelant peut alors dire à l'utilisateur que ce numéro ne peut rien recevoir.
   */
  recipientRejected: boolean;
}

/**
 * Résume l'échec de tous les canaux. La cause retenue est celle du dernier prestataire appelé :
 * un canal simplement sauté ne masque pas la vraie cause.
 */
export function summarizeFailure(attempts: readonly ChannelAttempt[], ttlExpired: boolean): DeliveryFailure {
  const failed = attempts.flatMap((attempt) => (attempt.outcome === 'failed' ? [attempt] : []));
  const lastReason = failed.at(-1)?.reason ?? 'provider_unavailable';
  return {
    channelsTried: attempts.map((attempt) => attempt.channel),
    reason: ttlExpired ? 'ttl_expired' : lastReason,
    recipientRejected:
      !ttlExpired && failed.length > 0 && failed.every((attempt) => attempt.reason === 'recipient_invalid'),
  };
}
