/** Enveloppe commune à tous les événements (contracts/events/envelope.schema.json). */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  /** UUID v7, utilisé pour ne jamais traiter deux fois le même événement. */
  eventId: string;
  /** <service>.<entité>.<action au passé>, par exemple "identity.user.registered". */
  type: TType;
  version: number;
  occurredAt: string;
  producer: string;
  correlationId: string;
  causationId?: string | null;
  payload: TPayload;
}
