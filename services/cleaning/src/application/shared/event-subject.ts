import { type CleaningDeps } from '../deps';

/**
 * Champs facultatifs ajoutés aux événements d'une demande ou d'une mission (ADR-034) : code et nom
 * de la prestation, groupe de demandes. Le nom est celui en vigueur au moment de l'événement ;
 * absent si la prestation n'existe plus.
 */
export interface EventSubject {
  serviceCode: string;
  serviceName?: string;
  groupId?: string;
}

export async function eventSubject(
  deps: Pick<CleaningDeps, 'catalog'>,
  source: { serviceCode: string; groupId: string | null },
): Promise<EventSubject> {
  const service = await deps.catalog.findService(source.serviceCode);
  return {
    serviceCode: source.serviceCode,
    ...(service?.name ? { serviceName: service.name } : {}),
    ...(source.groupId ? { groupId: source.groupId } : {}),
  };
}
