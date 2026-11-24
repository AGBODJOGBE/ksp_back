/**
 * Services autorisés à appeler SendNotification (contrat notification.proto, carte des services) :
 * codes de connexion d'identity (ADR-014), codes de signature de document (ADR-044), messages de
 * recovery au débiteur sans compte (ADR-061 : code d'accès, lien personnel, relances), et invitation
 * d'un agent de nettoyage qui n'a pas encore de compte (cleaning, R-AG-02 du CDC Nettoyage v2).
 */
export const DIRECT_SEND_CALLERS: readonly string[] = ['identity', 'document', 'recovery', 'cleaning'];

/**
 * Appelants limités à une liste fermée de modèles. cleaning n'envoie directement que l'invitation
 * d'un agent : tous ses autres messages (`cleaning.*`) partent de ses événements.
 */
const CLOSED_TEMPLATE_LISTS: Readonly<Record<string, readonly string[]>> = {
  cleaning: ['cleaning.agent_invitation'],
};

export function isDirectSendCaller(service: string): boolean {
  return DIRECT_SEND_CALLERS.includes(service);
}

/**
 * Chaque appelant n'envoie que ses propres modèles : ceux de sa liste fermée s'il en a une, sinon
 * ceux préfixés de son nom (`identity.*`, `document.*`, `recovery.*`). recovery ne peut pas envoyer
 * un code de connexion d'identity, ni document un message au débiteur. Un jeton volé ou un appel
 * détourné reste limité à son service.
 */
export function mayCallerSendTemplate(service: string, templateCode: string): boolean {
  if (!isDirectSendCaller(service)) return false;
  const closed = Object.hasOwn(CLOSED_TEMPLATE_LISTS, service) ? CLOSED_TEMPLATE_LISTS[service] : undefined;
  return closed ? closed.includes(templateCode) : templateCode.startsWith(`${service}.`);
}
