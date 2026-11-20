/**
 * Services autorisés à appeler SendNotification (contrat notification.proto, carte des services) :
 * codes de connexion d'identity (ADR-014), codes de signature de document (ADR-044), et messages
 * de recovery au débiteur sans compte (ADR-061 : code d'accès, lien personnel, relances).
 */
export const DIRECT_SEND_CALLERS: readonly string[] = ['identity', 'document', 'recovery'];

export function isDirectSendCaller(service: string): boolean {
  return DIRECT_SEND_CALLERS.includes(service);
}

/**
 * Chaque appelant n'envoie que ses propres modèles, préfixés de son nom (`identity.*`,
 * `document.*`, `recovery.*`) : recovery ne peut pas envoyer un code de connexion d'identity, ni
 * document un message au débiteur. Un jeton volé ou un appel détourné reste limité à son service.
 */
export function mayCallerSendTemplate(service: string, templateCode: string): boolean {
  return isDirectSendCaller(service) && templateCode.startsWith(`${service}.`);
}
