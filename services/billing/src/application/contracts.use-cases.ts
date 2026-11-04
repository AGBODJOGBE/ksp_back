import { type CleaningEventPayloads, type EventEnvelope } from '@ksp/contracts';
import { applyResumption, applySuspension, type BillingContract } from '../domain/contract';
import { type BillingDeps } from './ports';
import { BillingErrors } from './shared/errors';

/** Préfixe des consommateurs de billing dans l'inbox : un par type d'événement. */
const consumer = (eventType: string) => `billing.${eventType}`;

type Envelope<K extends keyof CleaningEventPayloads> = Pick<
  EventEnvelope<K, CleaningEventPayloads[K]>,
  'eventId' | 'type' | 'occurredAt' | 'payload'
>;

/**
 * Contrat à modifier par un événement de cleaning. Les événements n'arrivent pas forcément dans
 * l'ordre (ADR-032) : une annulation, une suspension ou une reprise peut précéder la confirmation
 * d'une mission d'organisation. Le contrat n'existe alors pas encore : l'erreur levée annule la
 * transaction (l'événement n'est pas marqué traité) et le message repasse par la file de reprise,
 * jusqu'à ce que la confirmation soit enregistrée. Une mission de particulier n'a jamais de contrat
 * (`organizationId` null) ; un événement sans organisation connue (`undefined`, publié avant
 * l'ADR-032) est ignoré comme avant.
 */
function existing(
  current: BillingContract | null,
  missionId: string,
  organizationId: string | null | undefined,
): BillingContract | null {
  if (current) return current;
  if (typeof organizationId === 'string') throw BillingErrors.contractNotYetRegistered(missionId);
  return null;
}

/**
 * cleaning.booking.confirmed : un contrat d'entreprise (mission d'une organisation) devient
 * facturable chaque mois. Un particulier n'est pas facturé ici : il paie ses passages (cleaning).
 * Durée : celle du contrat récurrent, 1 mois pour une prestation ponctuelle.
 */
export class RegisterContractUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(
    event: Envelope<'cleaning.booking.confirmed'>,
  ): Promise<'registered' | 'ignored' | 'duplicate'> {
    const { payload } = event;
    if (!payload.organizationId) return 'ignored';
    const contract: BillingContract = {
      id: payload.missionId,
      source: 'cleaning',
      customerId: payload.customerId,
      organizationId: payload.organizationId,
      total: payload.total.amount,
      durationMonths: payload.recurrence?.durationMonths ?? 1,
      startsAt: new Date(payload.startsAt ?? event.occurredAt),
      terminatedAt: null,
      suspendedSince: null,
      suspensions: [],
      lastResumedAt: null,
      serviceName: payload.serviceName ?? null,
      createdAt: this.deps.clock.now(),
    };
    const outcome = await this.deps.contracts.apply(
      event.eventId,
      consumer(event.type),
      contract.id,
      (current) => current ?? contract,
    );
    return outcome === 'duplicate' ? 'duplicate' : 'registered';
  }
}

/** cleaning.request.cancelled d'une mission : plus aucun mois facturé après l'annulation. */
export class TerminateContractUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(event: Envelope<'cleaning.request.cancelled'>): Promise<void> {
    const { missionId, organizationId } = event.payload;
    if (!missionId) return;
    const at = new Date(event.occurredAt);
    await this.deps.contracts.apply(event.eventId, consumer(event.type), missionId, (current) => {
      const contract = existing(current, missionId, organizationId);
      return contract && !contract.terminatedAt ? { ...contract, terminatedAt: at } : null;
    });
  }
}

/** cleaning.contract.suspended : facturation en pause ; un mois fini pendant la suspension n'est pas facturé. */
export class SuspendContractUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(event: Envelope<'cleaning.contract.suspended'>): Promise<void> {
    const at = new Date(event.payload.suspendedAt);
    await this.deps.contracts.apply(
      event.eventId,
      consumer(event.type),
      event.payload.missionId,
      (current) => {
        const contract = existing(current, event.payload.missionId, event.payload.organizationId);
        return contract ? applySuspension(contract, at) : null;
      },
    );
  }
}

/** cleaning.contract.resumed : la facturation reprend pour les mois suivants. */
export class ResumeContractUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(event: Envelope<'cleaning.contract.resumed'>): Promise<void> {
    const at = new Date(event.payload.resumedAt);
    await this.deps.contracts.apply(
      event.eventId,
      consumer(event.type),
      event.payload.missionId,
      (current) => {
        const contract = existing(current, event.payload.missionId, event.payload.organizationId);
        return contract ? applyResumption(contract, at) : null;
      },
    );
  }
}
