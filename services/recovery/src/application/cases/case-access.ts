import { hasRole, requireUser } from '@ksp/platform';
import { type Holder } from '../ports';
import { type Creditor, currentCreditor, ROLES, type Staff } from '../shared/access';
import { CaseErrors } from './case-errors';
import { type RecoveryCaseRecord, type StaffScope } from './ports';

/**
 * Périmètre des dossiers (ADR-060, point 13). Le créancier ne voit que les dossiers de son contexte
 * actif ; un membre lecteur de l'organisation (org_viewer) ne fait que les consulter. Au back-office,
 * un chargé seul ne voit que les dossiers qui lui sont affectés ; superviseur, administrateurs,
 * juriste et finance les voient tous (le juriste et la finance en lecture). Hors périmètre : 404.
 */

/** Membres d'une organisation qui agissent sur ses dossiers et débitent son portefeuille. */
const ORGANIZATION_WRITERS = ['org_admin', 'org_member'] as const;

/** Recevabilité et affectation (manifeste de la gateway : superviseurs). */
export const CASE_SUPERVISORS = [ROLES.supervisor, ROLES.admin, ROLES.superAdmin] as const;

/** Rôles qui voient tous les dossiers, hors affectation. */
const ALL_CASES_ROLES: readonly string[] = [
  ROLES.supervisor,
  ROLES.admin,
  ROLES.superAdmin,
  ROLES.legal,
  ROLES.finance,
];

/** Créancier connecté qui crée, modifie ou paie : lui-même, ou membre (non lecteur) de son organisation. */
export function creditorWriter(): Creditor {
  const creditor = currentCreditor();
  if (creditor.holder.type === 'organization') {
    const user = requireUser();
    const scope = { type: 'org' as const, id: creditor.holder.id };
    if (!ORGANIZATION_WRITERS.some((role) => hasRole(user, role, scope))) throw CaseErrors.viewerForbidden();
  }
  return creditor;
}

export function sameHolder(a: Holder, b: Holder): boolean {
  return a.type === b.type && a.id === b.id;
}

/** Dossier du créancier connecté, sinon introuvable. */
export function requireOwnCase(record: RecoveryCaseRecord | null, creditor: Creditor): RecoveryCaseRecord {
  if (!record || !sameHolder(record.creditor, creditor.holder)) throw CaseErrors.caseNotFound();
  return record;
}

/** Périmètre d'un membre du personnel : null = tous les dossiers ; sinon ceux du chargé. */
export function staffScope(staff: Staff, communeKey: string | null = null): StaffScope {
  const all = ALL_CASES_ROLES.some((role) => staff.roles.has(role));
  return { agentId: all ? null : staff.userId, communeKey };
}

/** Dossier dans le périmètre du membre du personnel, sinon introuvable. */
export function requireCaseInScope(record: RecoveryCaseRecord | null, staff: Staff): RecoveryCaseRecord {
  if (!record) throw CaseErrors.caseNotFound();
  const scope = staffScope(staff);
  if (scope.agentId !== null && record.assignedAgentId !== scope.agentId) throw CaseErrors.caseNotFound();
  return record;
}
