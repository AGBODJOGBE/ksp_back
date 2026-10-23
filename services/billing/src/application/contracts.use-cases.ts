import { type CleaningEventPayloads, type EventEnvelope } from '@ksp/contracts';
import { applyResumption, applySuspension, type BillingContract } from '../domain/contract';
import { type BillingDeps } from './ports';

/** Préfixe des consommateurs de billing dans l'inbox : un par type d'événement. */
const consumer = (eventType: string) => `billing.${eventType}`;

type Envelope<K extends keyof CleaningEventPayloads> = Pick<
  EventEnvelope<K, CleaningEventPayloads[K]>,
  'eventId' | 'type' | 'occurredAt' | 'payload'
>;

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
    const { missionId } = event.payload;
    if (!missionId) return;
    const at = new Date(event.occurredAt);
    await this.deps.contracts.apply(event.eventId, consumer(event.type), missionId, (current) =>
      current && !current.terminatedAt ? { ...current, terminatedAt: at } : null,
    );
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
      (current) => (current ? applySuspension(current, at) : null),
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
      (current) => (current ? applyResumption(current, at) : null),
    );
  }
}
