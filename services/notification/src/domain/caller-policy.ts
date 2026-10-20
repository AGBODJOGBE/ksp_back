/**
 * Services autorisés à appeler SendNotification (contrat notification.proto, carte des services) :
 * codes de connexion d'identity (ADR-014) et codes de signature de document.
 */
export const DIRECT_SEND_CALLERS: readonly string[] = ['identity', 'document'];

export function isDirectSendCaller(service: string): boolean {
  return DIRECT_SEND_CALLERS.includes(service);
}
