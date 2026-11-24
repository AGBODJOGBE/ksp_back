import { hasPermission, requirePermission, requireRecentMfa } from '@ksp/platform';
import {
  approveCredit,
  type ClaimDecisionResult,
  type ClaimOutcome,
  customerMessage,
  decideClaim,
  openClaim,
  redoSlot,
  staffUpdate,
} from '../../domain/claims/claim';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type OutboxMessage } from '../ports';
import { requireStaff } from '../shared/access';
import { CleaningErrors, cleaningErrors } from '../shared/errors';
import { runIdempotent, writeError } from '../shared/idempotency';
import { isUuid, page, type Page } from '../shared/input';
import { lotGErrors } from '../shared/lot-g.errors';
import { AMOUNTS_READ_PERMISSION } from '../settings/settings.use-cases';
import { type ClaimFilter, type ClaimPatch, type ClaimRecord, type NewClaimCredit } from './claims.ports';
import { type CustomerAccess, ownsCase, requireCustomer, requireOrganizationRole } from './customer-access';

/**
 * Réclamations (UC-NT-17 côté client, UC-NT-40 au back-office ; R-RC-01 à R-RC-04). Une réclamation
 * ouverte ne suspend pas le paiement de la séance (R-RC-04) : rien n'est touché côté paiement. Le
 * crédit d'un particulier est versé au wallet après la transaction, avec une clé fixe (RV-81).
 */

export const CLAIM_PERMISSION = 'cleaning.claim.manage';
/** Double authentification de moins de 10 minutes pour décider ou valider un crédit (contrat). */
export const CLAIM_DECISION_MFA_SECONDS = 600;
const CLAIM_SORTS = ['openedAt', '-openedAt'] as const;
const CLAIM_STATUSES = ['open', 'in_progress', 'resolved', 'rejected'];

export interface ClaimView {
  claim: ClaimRecord;
  /** Vue du personnel : noms du client et de l'auteur de la décision. */
  forStaff: boolean;
  showAmounts: boolean;
  names: Map<string, string>;
}

/** Refus du domaine → erreur du contrat. */
function unwrap<T>(result: ClaimDecisionResult<T>): T {
  if (result.ok) return result.value;
  const { code, details } = result.error;
  switch (code) {
    case 'CLEANING_VALIDATION_FAILED':
      throw CleaningErrors.validation(String(details.field), String(details.reason));
    case 'CLEANING_CLAIM_WINDOW_CLOSED':
      throw lotGErrors.claimWindowClosed(Number(details.windowHours));
    case 'CLEANING_SECOND_APPROVER_REQUIRED':
      throw lotGErrors.secondApproverRequired();
    default:
      throw CleaningErrors.invalidTransition(String(details.from), String(details.to));
  }
}

function statusFilter(status: string | null | undefined): string | null {
  if (!status) return null;
  if (!CLAIM_STATUSES.includes(status)) throw cleaningErrors.invalid('status', 'invalid_type');
  return status;
}

function sortOf(sort: string | undefined, fallback: ClaimFilter['sort']): ClaimFilter['sort'] {
  if (!sort) return fallback;
  if (!(CLAIM_SORTS as readonly string[]).includes(sort))
    throw cleaningErrors.invalid('sort', 'invalid_type');
  return sort as ClaimFilter['sort'];
}

/** Espace client : un seul tri, « -openedAt » (contrat ListMyClaims). */
function mineSort(sort: string | undefined): ClaimFilter['sort'] {
  if (sort && sort !== '-openedAt') throw cleaningErrors.invalid('sort', 'invalid_type');
  return '-openedAt';
}

/** Événement cleaning.claim.resolved, publié quand la réclamation est tranchée. */
function resolvedEvent(
  claim: ClaimRecord,
  patch: ClaimPatch,
  redoId: string | null,
  at: Date,
): OutboxMessage {
  const amount = patch.creditAmount ?? claim.creditAmount;
  return {
    type: 'cleaning.claim.resolved',
    payload: {
      claimId: claim.id,
      sessionId: claim.session.id,
      programId: claim.session.programId,
      customerId: claim.session.customerId,
      organizationId: claim.session.organizationId,
      outcome: (patch.decision ?? claim.decision)!,
      creditAmount: amount ? { amount, currency: 'XOF' } : null,
      redoSessionId: redoId ?? claim.redoSessionId,
      resolvedAt: at.toISOString(),
    },
  };
}

/** Lecture et écritures communes aux deux espaces. */
class ClaimSupport {
  constructor(protected readonly deps: CleaningDeps) {}

  protected async requireClaim(id: string): Promise<ClaimRecord> {
    const claim = isUuid(id) ? await this.deps.claims.claim(id) : null;
    if (!claim) throw lotGErrors.claimNotFound();
    return claim;
  }

  protected async view(claim: ClaimRecord, forStaff: boolean, showAmounts: boolean): Promise<ClaimView> {
    const ids = forStaff ? [claim.session.customerId, ...(claim.decidedBy ? [claim.decidedBy] : [])] : [];
    const [users, organizations] = await Promise.all([
      ids.length ? this.deps.people.userNames(ids) : new Map<string, string>(),
      forStaff && claim.session.organizationId
        ? this.deps.people.organizationNames([claim.session.organizationId])
        : new Map<string, string>(),
    ]);
    return { claim, forStaff, showAmounts, names: new Map([...users, ...organizations]) };
  }

  /** Écriture conditionnée par la version ; une version dépassée rend CLEANING_CONCURRENT_UPDATE. */
  protected async write(
    claim: ClaimRecord,
    patch: ClaimPatch,
    effects: { redo: Parameters<CleaningDeps['claims']['update']>[3]['redo']; credit: NewClaimCredit | null },
    changes: { events: OutboxMessage[]; audit: AuditEntry[] },
    stub: Parameters<Parameters<typeof runIdempotent>[0]['run']>[0],
    at: Date,
  ): Promise<void> {
    try {
      await this.deps.claims.update(
        claim.id,
        claim.version,
        patch,
        { ...effects, at },
        { ...changes, idempotency: stub({ claimId: claim.id }) },
      );
    } catch (error) {
      throw writeError(error);
    }
  }

  /**
   * Versement du crédit au wallet, après la transaction (RV-81) : clé fixe, rejouable. Une panne
   * laisse l'opération « pending », reprise par la tâche de rejeu des crédits.
   */
  protected async payCredit(claimId: string): Promise<void> {
    const credit = await this.deps.claims.pendingCredit(claimId);
    if (!credit) return;
    try {
      const result = await this.deps.wallet.credit({
        idempotencyKey: credit.idempotencyKey,
        holder: { type: credit.holder.kind, id: credit.holder.id },
        amount: credit.amount,
        object: { objectType: 'cleaning_claim', objectId: claimId, part: 'credit' },
        kind: 'commercial_gesture',
        description: credit.label,
      });
      await this.deps.claims.settleCredit(credit.id, {
        status: 'succeeded',
        transactionId: result.transactionId,
        failureCode: null,
        at: this.deps.clock.now(),
      });
    } catch {
      // Opération laissée « pending » : rejouée avec la même clé, jamais versée deux fois.
    }
  }
}

/** Espace client : déposer, suivre et répondre (UC-NT-17). */
export class ClaimUseCases extends ClaimSupport {
  async open(input: {
    sessionId: string;
    idempotencyKey: string;
    category: string;
    text: string;
    photoFileIds: string[];
  }): Promise<ClaimView> {
    const access = requireCustomer();
    requireOrganizationRole(access, 'org_member');
    const session = isUuid(input.sessionId) ? await this.deps.claims.session(input.sessionId) : null;
    if (!session || !ownsCase(access, session)) throw lotGErrors.sessionNotFound();
    const now = this.deps.clock.now();
    const { windowHours } = await this.deps.claims.claimSettings();
    const photoFileIds = [...new Set(input.photoFileIds)];
    if (photoFileIds.some((id) => !isUuid(id))) throw cleaningErrors.invalid('photoFileIds', 'invalid_type');
    const body = { sessionId: session.id, category: input.category, text: input.text.trim(), photoFileIds };
    const claimId = await runIdempotent({
      store: this.deps.idempotency,
      actorId: access.userId,
      operation: 'claim.open',
      key: input.idempotencyKey,
      body,
      at: now,
      run: async (stub) => {
        // Contrôles dans le premier passage seulement : un rejeu rend la réclamation déjà déposée.
        const accepted = unwrap(openClaim(session, { ...input, photoFileIds }, now, windowHours));
        const id = this.deps.ids.next();
        for (const fileId of photoFileIds) {
          await this.deps.photos.attach({
            fileId,
            subject: { type: 'cleaning_claim', id },
            ownerId: access.userId,
          });
        }
        await this.deps.claims.insert(
          { id, sessionId: session.id, openedBy: access.userId, ...accepted, at: now },
          {
            events: [
              {
                type: 'cleaning.claim.opened',
                payload: {
                  claimId: id,
                  sessionId: session.id,
                  programId: session.programId,
                  customerId: session.customerId,
                  organizationId: session.organizationId,
                  category: accepted.category,
                  openedAt: now.toISOString(),
                  communeKey: session.communeKey,
                },
              },
            ],
            audit: [],
            idempotency: stub({ claimId: id }),
          },
        );
        return id;
      },
      replay: async (response) => String(response.claimId),
    });
    return this.view(await this.requireClaim(claimId), false, true);
  }

  async listMine(input: {
    status?: string;
    limit?: number;
    cursor?: string;
    sort?: string;
  }): Promise<Page<ClaimView>> {
    const access = requireCustomer();
    const result = await this.deps.claims.list(
      {
        owner: access.owner,
        status: statusFilter(input.status),
        agentId: null,
        customerId: null,
        organizationId: null,
        sort: mineSort(input.sort),
      },
      page(input.limit, input.cursor, (value) => /^\d{1,6}$/.test(value)),
    );
    return { ...result, items: await Promise.all(result.items.map((c) => this.view(c, false, true))) };
  }

  async getMine(claimId: string): Promise<ClaimView> {
    return this.view(await this.mine(requireCustomer(), claimId), false, true);
  }

  async addMessage(input: { claimId: string; idempotencyKey: string; text: string }): Promise<ClaimView> {
    const access = requireCustomer();
    requireOrganizationRole(access, 'org_member');
    const claim = await this.mine(access, input.claimId);
    const now = this.deps.clock.now();
    await runIdempotent({
      store: this.deps.idempotency,
      actorId: access.userId,
      operation: 'claim.message',
      key: input.idempotencyKey,
      body: { claimId: claim.id, text: input.text.trim() },
      at: now,
      run: (stub) =>
        this.write(
          claim,
          {
            message: {
              id: this.deps.ids.next(),
              authorId: access.userId,
              fromStaff: false,
              body: unwrap(customerMessage(claim, input.text)),
            },
          },
          { redo: null, credit: null },
          { events: [], audit: [] },
          stub,
          now,
        ),
      replay: async () => undefined,
    });
    return this.view(await this.requireClaim(claim.id), false, true);
  }

  private async mine(access: CustomerAccess, claimId: string): Promise<ClaimRecord> {
    const claim = await this.requireClaim(claimId);
    if (!ownsCase(access, claim.session)) throw lotGErrors.claimNotFound();
    return claim;
  }
}

/** Back-office : file, prise en charge, décision et validation du crédit (UC-NT-40). */
export class ClaimAdminUseCases extends ClaimSupport {
  private staff(): { actorId: string; showAmounts: boolean } {
    const actorId = requireStaff();
    const user = requirePermission(CLAIM_PERMISSION);
    return { actorId, showAmounts: hasPermission(user, AMOUNTS_READ_PERMISSION) };
  }

  async list(input: {
    status?: string;
    agentId?: string;
    customerId?: string;
    organizationId?: string;
    limit?: number;
    cursor?: string;
    sort?: string;
  }): Promise<Page<ClaimView>> {
    const { showAmounts } = this.staff();
    const result = await this.deps.claims.list(
      {
        owner: null,
        status: statusFilter(input.status),
        agentId: input.agentId || null,
        customerId: input.customerId || null,
        organizationId: input.organizationId || null,
        sort: sortOf(input.sort, 'openedAt'),
      },
      page(input.limit, input.cursor, (value) => /^\d{1,6}$/.test(value)),
    );
    return { ...result, items: await Promise.all(result.items.map((c) => this.view(c, true, showAmounts))) };
  }

  async get(claimId: string): Promise<ClaimView> {
    const { showAmounts } = this.staff();
    return this.view(await this.requireClaim(claimId), true, showAmounts);
  }

  async update(input: {
    claimId: string;
    idempotencyKey: string;
    status?: string | null;
    message?: string | null;
  }): Promise<ClaimView> {
    const { actorId, showAmounts } = this.staff();
    const claim = await this.requireClaim(input.claimId);
    const now = this.deps.clock.now();
    await runIdempotent({
      store: this.deps.idempotency,
      actorId,
      operation: 'claim.update',
      key: input.idempotencyKey,
      body: { claimId: claim.id, status: input.status ?? null, message: input.message?.trim() ?? null },
      at: now,
      run: (stub) => {
        const change = unwrap(
          staffUpdate(claim, { status: input.status ?? null, message: input.message ?? null }, now),
        );
        return this.write(
          claim,
          {
            status: change.status,
            firstResponseAt: change.firstResponseAt,
            ...(change.message
              ? {
                  message: {
                    id: this.deps.ids.next(),
                    authorId: actorId,
                    fromStaff: true,
                    body: change.message,
                  },
                }
              : {}),
          },
          { redo: null, credit: null },
          { events: [], audit: [] },
          stub,
          now,
        );
      },
      replay: async () => undefined,
    });
    return this.view(await this.requireClaim(claim.id), true, showAmounts);
  }

  async decide(input: {
    claimId: string;
    idempotencyKey: string;
    outcome: string;
    creditAmount: number | null;
    reason: string;
  }): Promise<ClaimView> {
    const { actorId, showAmounts } = this.staff();
    requireRecentMfa(CLAIM_DECISION_MFA_SECONDS);
    const claim = await this.requireClaim(input.claimId);
    const now = this.deps.clock.now();
    await runIdempotent({
      store: this.deps.idempotency,
      actorId,
      operation: 'claim.decide',
      key: input.idempotencyKey,
      body: {
        claimId: claim.id,
        outcome: input.outcome,
        creditAmount: input.creditAmount,
        reason: input.reason.trim(),
      },
      at: now,
      run: async (stub) => {
        const decision = unwrap(
          decideClaim(
            claim,
            {
              outcome: input.outcome as ClaimOutcome,
              creditAmount: input.creditAmount,
              reason: input.reason,
            },
            actorId,
          ),
        );
        const closed = decision.status !== 'in_progress';
        const patch: ClaimPatch = {
          status: decision.status,
          decision: decision.outcome,
          decisionReason: decision.reason,
          creditAmount: decision.creditAmount,
          decidedBy: actorId,
          decidedAt: now,
          firstResponseAt: claim.firstResponseAt ?? now,
          closedAt: closed ? now : null,
        };
        let redo = null;
        if (decision.outcome === 'free_redo') {
          const { leadHours } = await this.deps.claims.claimSettings();
          const slot = redoSlot(
            claim.session,
            now,
            leadHours,
            await this.deps.claims.programSlots(claim.session.programId),
          );
          redo = {
            id: this.deps.ids.next(),
            programId: claim.session.programId,
            communeKey: claim.session.communeKey,
            ...slot,
          };
        }
        const credit =
          decision.outcome === 'wallet_credit' && !decision.pendingApproval
            ? this.creditOf(claim, decision.creditAmount!, actorId)
            : null;
        return this.write(
          claim,
          patch,
          { redo, credit },
          {
            events: closed ? [resolvedEvent(claim, patch, redo?.id ?? null, now)] : [],
            audit: [
              {
                actorId,
                action: 'claim.decided',
                entityType: 'claim',
                entityId: claim.id,
                at: now,
                details: {
                  before: claim.status,
                  after: decision.status,
                  outcome: decision.outcome,
                  creditAmount: decision.creditAmount,
                  pendingApproval: decision.pendingApproval,
                  redoSessionId: redo?.id ?? null,
                },
              },
            ],
          },
          stub,
          now,
        );
      },
      replay: async () => undefined,
    });
    await this.payCredit(claim.id);
    return this.view(await this.requireClaim(claim.id), true, showAmounts);
  }

  async approveCredit(input: { claimId: string; idempotencyKey: string }): Promise<ClaimView> {
    const { actorId, showAmounts } = this.staff();
    requireRecentMfa(CLAIM_DECISION_MFA_SECONDS);
    const claim = await this.requireClaim(input.claimId);
    const now = this.deps.clock.now();
    await runIdempotent({
      store: this.deps.idempotency,
      actorId,
      operation: 'claim.approve_credit',
      key: input.idempotencyKey,
      body: { claimId: claim.id },
      at: now,
      run: (stub) => {
        unwrap(approveCredit(claim, actorId));
        const patch: ClaimPatch = { status: 'resolved', creditApprovedBy: actorId, closedAt: now };
        return this.write(
          claim,
          patch,
          { redo: null, credit: this.creditOf(claim, claim.creditAmount!, actorId) },
          {
            events: [resolvedEvent(claim, patch, null, now)],
            audit: [
              {
                actorId,
                action: 'claim.credit_approved',
                entityType: 'claim',
                entityId: claim.id,
                at: now,
                details: {
                  before: claim.status,
                  after: 'resolved',
                  creditAmount: claim.creditAmount,
                  decidedBy: claim.decidedBy,
                },
              },
            ],
          },
          stub,
          now,
        );
      },
      replay: async () => undefined,
    });
    await this.payCredit(claim.id);
    return this.view(await this.requireClaim(claim.id), true, showAmounts);
  }

  /**
   * Crédit d'un particulier : opération de wallet à verser (RV-81). Pour une entreprise, le crédit est
   * un avoir billing (RV-97) : aucun appel à wallet ; l'émission de l'avoir n'est pas branchée ici.
   */
  private creditOf(claim: ClaimRecord, amount: number, actorId: string): NewClaimCredit | null {
    if (claim.session.ownerKind !== 'user') return null;
    return {
      id: this.deps.ids.next(),
      idempotencyKey: `cleaning_claim_credit:${claim.id}`,
      holder: { kind: 'user', id: claim.session.ownerId },
      amount,
      label: `Nettoyage — geste commercial, séance ${claim.session.rank}/${claim.session.sessionsCount}`,
      sessionId: claim.session.id,
      createdBy: actorId,
    };
  }
}
