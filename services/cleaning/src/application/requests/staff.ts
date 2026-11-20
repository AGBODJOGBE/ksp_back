import { requirePermission, requireUser } from '@ksp/platform';
import { requireStaff } from '../shared/access';

/**
 * Permissions du back-office pour le dossier (partie 2, 16.3). La gateway vérifie la permission de
 * la route ; le service la revérifie depuis le jeton (ADR-057), dans la commune du dossier pour une
 * portée par zone (R-RB-03). Interprétation prudente : un jeton qui ne porte aucune permission
 * (jeton d'avant leur ajout) s'en remet au contrôle de la gateway.
 */
export const CASE_PERMISSIONS = {
  read: 'cleaning.request.read',
  process: 'cleaning.request.process',
  quoteManage: 'cleaning.quote.manage',
  adjustPrice: 'cleaning.quote.adjust_price',
  amountsRead: 'cleaning.amounts.read',
  visitPerform: 'cleaning.visit.perform',
} as const;

/** Membre du back-office (double authentification) qui a la permission ; renvoie son compte. */
export function staffWith(permission: string, zoneKey?: string): string {
  const staffId = requireStaff();
  if (requireUser().permissions !== undefined) requirePermission(permission, zoneKey);
  return staffId;
}

/** Montants visibles du personnel seulement avec cleaning.amounts.read (R-EX-04). */
export function seesAmounts(zoneKey?: string): boolean {
  const user = requireUser();
  if (user.permissions === undefined) return true;
  return (
    user.permissions.includes(CASE_PERMISSIONS.amountsRead) ||
    (zoneKey !== undefined &&
      (user.zonePermissions?.[zoneKey]?.includes(CASE_PERMISSIONS.amountsRead) ?? false))
  );
}
