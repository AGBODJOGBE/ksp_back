import { type CaseObligations } from './ports';
import { OBLIGATION_CALLERS, requireCaller } from './shared/access';
import { RecoveryErrors } from './shared/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PendingObligation {
  kind: string;
  reference: string;
  description: string;
}

/**
 * Obligations qui empêchent la suppression d'un compte (ksp.common.v1.ObligationService, UC-ID-11,
 * ADR-036) : un dossier du compte, ou de l'organisation demandée, encore ouvert (en examen, actif ou
 * suspendu). Réservé à identity.
 */
export class HasPendingObligationsUseCase {
  constructor(private readonly deps: { cases: CaseObligations }) {}

  async execute(input: { userId: string; organizationId: string }): Promise<PendingObligation[]> {
    requireCaller(OBLIGATION_CALLERS);
    const organizationId = input.organizationId?.trim();
    const creditor = organizationId
      ? { type: 'organization' as const, id: organizationId }
      : { type: 'user' as const, id: input.userId };
    if (!UUID.test(creditor.id)) throw RecoveryErrors.invalid(organizationId ? 'organizationId' : 'userId');
    const open = await this.deps.cases.openCases(creditor);
    return open.map((recoveryCase) => ({
      kind: 'open_recovery_case',
      reference: recoveryCase.number,
      description: `Le dossier de recouvrement ${recoveryCase.number} est en cours : arrêtez-le ou attendez sa clôture.`,
    }));
  }
}
