import { type cleaningV1 } from '@ksp/contracts';
import { type ClaimView } from '../../application/claims/claims.use-cases';
import { approvalStatus } from '../../domain/claims/claim';
import { money } from './catalog.presenters';

/**
 * Réclamation → message du contrat. Le personnel voit les noms du client et de l'auteur de la
 * décision ; le montant du crédit n'est rendu qu'avec cleaning.amounts.read (le client voit le sien).
 */
export function toClaim(view: ClaimView): cleaningV1.Claim {
  const { claim, names } = view;
  const decision: cleaningV1.ClaimDecision | undefined =
    claim.decision && claim.decidedBy && claim.decidedAt
      ? {
          outcome: claim.decision,
          ...(view.showAmounts && claim.creditAmount !== null
            ? { creditAmount: money(claim.creditAmount) }
            : {}),
          ...(claim.redoSessionId ? { redoSessionId: claim.redoSessionId } : {}),
          reason: claim.decisionReason ?? '',
          decidedBy: claim.decidedBy,
          decidedAt: claim.decidedAt.toISOString(),
          approvalStatus: approvalStatus(claim),
          ...(claim.creditApprovedBy ? { approvedBy: claim.creditApprovedBy } : {}),
          ...(view.forStaff && names.get(claim.decidedBy)
            ? { decidedByName: names.get(claim.decidedBy)! }
            : {}),
        }
      : undefined;
  const customerName = view.forStaff ? names.get(claim.session.customerId) : undefined;
  const organizationName =
    view.forStaff && claim.session.organizationId ? names.get(claim.session.organizationId) : undefined;
  return {
    id: claim.id,
    sessionId: claim.session.id,
    programId: claim.session.programId,
    customerId: claim.session.customerId,
    ...(claim.session.organizationId ? { organizationId: claim.session.organizationId } : {}),
    category: claim.category,
    text: claim.text,
    photos: claim.photoFileIds.map((fileId) => ({
      fileId,
      kind: 'claim',
      takenAt: claim.openedAt.toISOString(),
    })),
    status: claim.status,
    messages: claim.messages.map((m) => ({
      id: m.id,
      author: m.fromStaff ? 'staff' : 'customer',
      authorId: m.authorId,
      text: m.body,
      at: m.createdAt.toISOString(),
    })),
    ...(decision ? { decision } : {}),
    openedAt: claim.openedAt.toISOString(),
    ...(claim.firstResponseAt ? { firstResponseAt: claim.firstResponseAt.toISOString() } : {}),
    ...(claim.closedAt ? { closedAt: claim.closedAt.toISOString() } : {}),
    ...(customerName ? { customerName } : {}),
    ...(organizationName ? { organizationName } : {}),
  };
}

export function toClaimPage(page: { items: ClaimView[]; nextCursor: string | null; total: number }) {
  return { items: page.items.map(toClaim), nextCursor: page.nextCursor ?? '', total: page.total };
}
