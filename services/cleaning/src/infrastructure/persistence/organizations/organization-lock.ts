import { isUuid } from '../agents/agent-rows';
import { type Tx } from '../changes';

/** Espace des verrous consultatifs par organisation (clé à deux entiers, propre à cleaning). */
export const ORGANIZATION_LOCK_NAMESPACE = 54_054_085;

/**
 * Verrou d'une organisation (RV-85), tenu jusqu'à la fin de la transaction : les décisions qui
 * dépendent de son état (factures impayées, suspension par KSP, demande, frais de visite,
 * acceptation d'un devis, reprise d'un programme) passent l'une après l'autre.
 *
 * `SELECT … FOR UPDATE` sur sa ligne d'organization_billing_standings ; si elle n'existe pas
 * encore, verrou consultatif de transaction propre à l'organisation, puis nouvelle lecture : la
 * ligne a pu être créée par la transaction qui tenait ce verrou, et ceux qui arrivent ensuite ne
 * prennent que la ligne.
 */
export async function lockOrganization(tx: Tx, organizationId: string): Promise<void> {
  if (!isUuid(organizationId)) return;
  const lockRow = () => tx.$queryRaw<{ organization_id: string }[]>`
    SELECT organization_id FROM organization_billing_standings
    WHERE organization_id = ${organizationId}::uuid FOR UPDATE`;
  if ((await lockRow()).length > 0) return;
  // $executeRaw : la fonction rend `void`, que $queryRaw ne sait pas lire.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(${ORGANIZATION_LOCK_NAMESPACE}::int, hashtext(${organizationId.toLowerCase()}))`;
  await lockRow();
}
