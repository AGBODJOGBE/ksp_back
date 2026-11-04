import { groupQuotesTotal, groupRemainingDue } from '../../domain/request-group';
import { type CleaningDeps, presentRequest } from '../deps';
import { FIELD_WORK, requireStaff, seesEverything } from '../shared/access';
import { anyGroup, requestForStaff } from './group-support';
import { type QuoteRequestGroupView } from '../ports';

/** Totaux d'un groupe affichés au client (ADR-035) : entiers XOF, null quand inconnus. */
export interface GroupTotals {
  quotesTotal: number | null;
  remainingDue: number | null;
}

/** Total des devis envoyés et reste dû des missions du groupe ; pas de paiement groupé. */
export class GroupTotalsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(view: QuoteRequestGroupView): Promise<GroupTotals> {
    const missions = view.requests.some((request) => request.missionId)
      ? await this.deps.missions.listForGroup(view.group.id)
      : [];
    return {
      quotesTotal: groupQuotesTotal(view.requests, this.deps.clock.now()),
      remainingDue: groupRemainingDue(missions),
    };
  }
}

/**
 * Groupe vu du back-office après une opération (ADR-035) : toutes ses demandes pour la supervision ;
 * pour un agent, seulement celles dont il a la visite, position masquée une fois la visite close.
 */
export class GetRequestGroupUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(groupId: string): Promise<QuoteRequestGroupView> {
    const staff = requireStaff(FIELD_WORK);
    const view = await anyGroup(this.deps, groupId);
    const now = this.deps.clock.now();
    const visible = seesEverything(staff)
      ? view.requests
      : view.requests.filter((request) => request.visit?.agentId === staff.userId);
    return {
      group: view.group,
      requests: visible.map((request) => requestForStaff(staff, presentRequest(request, now))),
    };
  }
}
