import { type AccountErasure, type DocumentDeps } from './ports';

const BATCH = 100;
const MAX_BATCHES = 50;

/**
 * Clôture planifiée des demandes expirées (ADR-044) : statut enregistré et coordonnées en clair du
 * signataire effacées. Les lectures présentent déjà une demande échue comme expirée.
 */
export class ExpireSignaturesUseCase {
  constructor(private readonly deps: DocumentDeps) {}

  async execute(): Promise<{ expired: number }> {
    let expired = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const count = await this.deps.documents.expireDue(this.deps.clock.now(), BATCH);
      expired += count;
      if (count < BATCH) break;
    }
    return { expired };
  }
}

/**
 * Compte supprimé (`identity.user.deleted`, ADR-036) : les documents signés sont des preuves,
 * gardés et détachés du compte ; les demandes en attente qui lui sont adressées sont annulées.
 */
export class EraseAccountUseCase {
  static readonly CONSUMER = 'document.identity.user.deleted';

  constructor(private readonly deps: DocumentDeps) {}

  async execute(input: { eventId: string; userId: string }): Promise<AccountErasure> {
    return this.deps.documents.eraseAccount(input.userId.toLowerCase(), {
      eventId: input.eventId,
      consumer: EraseAccountUseCase.CONSUMER,
      now: this.deps.clock.now(),
    });
  }
}
