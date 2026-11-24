import { tryNormalizePhone } from '@ksp/platform';
import { type AgentDeps } from '../deps';
import { audit } from '../planning/assignment-support';
import { cleaningErrors } from '../shared/errors';
import { replayed, writeError } from '../shared/idempotency';
import { idempotencyKey, requestHash } from '../shared/input';
import { requireAgentAdmin } from './agent-access';
import { AgentAlreadyRegisteredError } from './agent.ports';
import {
  type AgentApplicationInput,
  applicantName,
  attachApplicationFiles,
  insertAgentFromApplication,
  parseApplication,
  requireCatalog,
} from './agent-registration.use-cases';
import { agentProfile, type AgentProfile } from './agent-views';

export interface CreateAgentInput extends AgentApplicationInput {
  /** Téléphone du compte KSP de l'agent. */
  phone: string;
}

/** Numéro reçu, ramené à la forme commune (ADR-063) ; identity le contrôle de nouveau. */
export function agentPhone(value: string | undefined | null): string {
  if (!value?.trim()) throw cleaningErrors.invalid('phone', 'required');
  const phone = tryNormalizePhone(value);
  if (!phone) throw cleaningErrors.invalid('phone', 'invalid_type');
  return phone;
}

/**
 * Création d'un agent par l'admin Nettoyage (UC-NT-35, R-AG-02) : mêmes informations et mêmes
 * contrôles que l'inscription. Le compte KSP est trouvé ou créé par son téléphone chez identity
 * (EnsureUserByPhone) ; l'agent est créé « en vérification », `createdBy` = l'admin. Le téléphone
 * n'est gardé ni dans la base de cleaning, ni dans le journal, ni dans l'événement.
 *
 * Ordre des écritures : le compte d'abord (appel idempotent d'identity), puis les fichiers rattachés
 * chez file, puis l'agent en une transaction. identity injoignable ou qui refuse : rien n'est écrit.
 * Écriture locale en échec après la création du compte : il reste un compte en attente sans agent,
 * que le rejeu de la création retrouve.
 */
export class CreateAgentUseCase {
  constructor(private readonly deps: AgentDeps) {}

  async execute(input: CreateAgentInput): Promise<AgentProfile> {
    const actorId = requireAgentAdmin();
    const key = idempotencyKey(input.idempotencyKey);
    const phone = agentPhone(input.phone);
    const application = parseApplication(input);
    // Empreinte de la requête : le téléphone y est mêlé aux identifiants aléatoires des fichiers.
    const hash = requestHash({ phone, application });
    const ref = { actorId, operation: 'agent.create', key };
    const replay = await replayed<{ agentId: string }>(this.deps.planning, ref, hash);
    if (replay) return this.profile(replay.agentId);

    await requireCatalog(this.deps, application.skillCodes, application.zoneKeys);
    const account = await this.deps.accounts.ensureByPhone({ phone, ...applicantName(input) });
    if (await this.deps.planning.agentByUserId(account.userId)) throw cleaningErrors.alreadyRegistered();
    const agentId = this.deps.ids.next();
    // Photo et pièce d'identité envoyées par l'admin pour l'agent.
    await attachApplicationFiles(this.deps, agentId, application, actorId);
    const now = this.deps.clock.now();
    const settings = await this.deps.planning.settings();
    try {
      await this.deps.planning.transaction(async (tx) => {
        const applied = await insertAgentFromApplication(this.deps, tx, settings, {
          agentId,
          userId: account.userId,
          status: 'under_review',
          createdBy: actorId,
          source: 'admin_created',
          application,
          by: actorId,
          now,
        });
        await tx.write({
          events: [applied],
          audit: [
            audit(actorId, 'agent.status_changed', 'agent', agentId, now, {
              before: null,
              after: 'under_review',
              source: 'admin_created',
            }),
          ],
        });
        await tx.remember({ ...ref, requestHash: hash, response: { agentId } });
      });
    } catch (error) {
      if (error instanceof AgentAlreadyRegisteredError) throw cleaningErrors.alreadyRegistered();
      throw writeError(error);
    }
    return this.profile(agentId);
  }

  private async profile(agentId: string): Promise<AgentProfile> {
    const agent = await this.deps.planning.agentById(agentId);
    if (!agent) throw cleaningErrors.agentNotFound();
    return agentProfile(this.deps, agent);
  }
}
