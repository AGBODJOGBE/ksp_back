import { type AgentDeps } from '../deps';
import { audit } from '../planning/assignment-support';
import { cleaningErrors } from '../shared/errors';
import { replayed, writeError } from '../shared/idempotency';
import { idempotencyKey, requestHash } from '../shared/input';
import { requireAgentAdmin } from './agent-access';
import { agentPhone } from './agent-creation.use-case';
import { agentErrors } from './agent-errors';
import { type InvitationRecord, InvitationSendFailedError } from './agent.ports';
import { cipherContext } from './agent-views';

/** Durée de validité d'une invitation (R-AG-02) : 7 jours ; aucun réglage du module ne la porte. */
export const INVITATION_VALIDITY_MS = 7 * 24 * 3_600_000;

export interface InviteAgentInput {
  idempotencyKey: string;
  /** Téléphone de la personne invitée. */
  phone: string;
}

export interface AgentInvitationView {
  id: string;
  /** Numéro invité, tel que l'admin vient de le donner (forme commune). */
  phone: string;
  expiresAt: Date;
}

/**
 * Invitation d'un agent par l'admin Nettoyage (UC-NT-35, R-AG-02) : un lien d'inscription est envoyé
 * au numéro, par notification. Le numéro n'est gardé que chiffré, avec son empreinte à clé ; il ne
 * figure ni dans le journal d'audit ni dans l'empreinte de la requête (qui porte l'empreinte à clé).
 *
 * Un numéro n'a qu'une invitation en cours : inviter de nouveau le même numéro, avec une autre clé,
 * renouvelle la sienne (nouvelle échéance) et la renvoie. Un numéro dont le compte est déjà agent est
 * refusé (CLEANING_AGENT_ALREADY_REGISTERED).
 *
 * Ordre des écritures : l'invitation est enregistrée avec la clé d'idempotence, puis envoyée. Envoi
 * en échec : l'appel répond NOTIFICATION_UNAVAILABLE et se rejoue avec la même clé ; le rejeu reprend
 * l'envoi de la même invitation, sans en créer une seconde. La clé d'envoi porte le numéro de la
 * tentative : même numéro tant que notification n'a pas répondu (elle écarte alors un doublon),
 * numéro suivant quand elle a répondu que tous les canaux ont échoué (elle rejouerait sinon cet échec).
 */
export class InviteAgentUseCase {
  constructor(private readonly deps: AgentDeps) {}

  async execute(input: InviteAgentInput): Promise<AgentInvitationView> {
    const actorId = requireAgentAdmin();
    const key = idempotencyKey(input.idempotencyKey);
    const phone = agentPhone(input.phone);
    const fingerprint = this.deps.phoneFingerprints.invitationPhone(phone);
    const hash = requestHash({ phoneFingerprint: fingerprint });
    const ref = { actorId, operation: 'agent.invite', key };
    const replay = await replayed<{ invitationId: string }>(this.deps.planning, ref, hash);
    const invitation = replay
      ? await this.recorded(replay.invitationId)
      : await this.open({ actorId, phone, fingerprint, ref, hash });

    const pending = !invitation.sentAt && !invitation.consumedAt;
    if (pending && invitation.expiresAt.getTime() > this.deps.clock.now().getTime()) {
      await this.send(invitation, phone);
    }
    return { id: invitation.id, phone, expiresAt: invitation.expiresAt };
  }

  private async recorded(invitationId: string): Promise<InvitationRecord> {
    const invitation = await this.deps.planning.invitationById(invitationId);
    if (!invitation) throw new Error('Invitation enregistrée introuvable.');
    return invitation;
  }

  private async open(input: {
    actorId: string;
    phone: string;
    fingerprint: string;
    ref: { actorId: string; operation: string; key: string };
    hash: string;
  }): Promise<InvitationRecord> {
    const { actorId, phone, ref, hash } = input;
    const account = await this.deps.accounts.findByPhone(phone);
    if (account && (await this.deps.planning.agentByUserId(account.userId))) {
      throw cleaningErrors.alreadyRegistered();
    }
    const id = this.deps.ids.next();
    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + INVITATION_VALIDITY_MS);
    try {
      return await this.deps.planning.transaction(async (tx) => {
        const invitation = await tx.openInvitation({
          id,
          phoneEncrypted: this.deps.cipher.encrypt(phone, cipherContext.invitationPhone(id)),
          phoneFingerprint: input.fingerprint,
          createdBy: actorId,
          createdAt: now,
          expiresAt,
        });
        await tx.write({
          events: [],
          audit: [
            audit(actorId, 'agent.invited', 'agent_invitation', invitation.id, now, {
              expiresAt: invitation.expiresAt.toISOString(),
              renewed: invitation.id !== id,
            }),
          ],
        });
        await tx.remember({ ...ref, requestHash: hash, response: { invitationId: invitation.id } });
        return invitation;
      });
    } catch (error) {
      throw writeError(error);
    }
  }

  private async send(invitation: InvitationRecord, phone: string): Promise<void> {
    let sent = true;
    try {
      await this.deps.invitations.send({
        invitationId: invitation.id,
        attempt: invitation.sendAttempts + 1,
        phone,
        expiresAt: invitation.expiresAt,
      });
    } catch (error) {
      // notification injoignable : la tentative n'est pas comptée, le rejeu reprend la même clé d'envoi.
      if (!(error instanceof InvitationSendFailedError)) throw error;
      sent = false;
    }
    const at = this.deps.clock.now();
    await this.deps.planning.transaction((tx) => tx.recordInvitationSend(invitation.id, sent ? at : null));
    if (!sent) throw agentErrors.dependencyUnavailable('notification');
  }
}
