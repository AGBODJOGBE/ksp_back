import { type EventEnvelope } from '@ksp/contracts';
import { type RabbitMqConsumer } from '@ksp/platform';
import { type RecoveryUseCases } from '../../application/use-cases';
import { MandateSignatureConsumer } from './mandate-signature.consumer';

describe('abonnement aux signatures de document', () => {
  it('transmet la signature du mandat au cas d’usage, identifiants seulement', async () => {
    let handler: ((envelope: EventEnvelope) => Promise<void>) | null = null;
    const consumer = {
      subscribe: async (type: string, fn: (envelope: EventEnvelope) => Promise<void>) => {
        expect(type).toBe('document.signature.completed');
        handler = fn;
      },
    } as unknown as RabbitMqConsumer;
    const calls: unknown[] = [];
    const useCases = {
      recordMandateSignature: {
        execute: async (input: unknown) => {
          calls.push(input);
          return 'recorded';
        },
      },
    } as unknown as RecoveryUseCases;
    await new MandateSignatureConsumer(consumer, useCases).onApplicationBootstrap();
    await handler!({
      eventId: 'e-1',
      type: 'document.signature.completed',
      version: 1,
      occurredAt: '2026-11-20T09:00:00.000Z',
      producer: 'document',
      correlationId: 'c-1',
      causationId: null,
      payload: {
        documentId: 'd-1',
        signatureRequestId: 's-1',
        template: 'recovery_mandate',
        templateVersion: 1,
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: 'case-1',
        ownerId: 'u-1',
        signerUserId: 'u-1',
        method: 'one_time_code',
        channel: 'whatsapp',
        documentSha256: 'a',
        signedFileId: 'f-1',
        signedDocumentSha256: 'b',
        signedAt: '2026-11-20T09:00:00.000Z',
      },
    } as EventEnvelope);
    expect(calls).toEqual([
      {
        eventId: 'e-1',
        documentId: 'd-1',
        template: 'recovery_mandate',
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: 'case-1',
        signerUserId: 'u-1',
        signedAt: '2026-11-20T09:00:00.000Z',
      },
    ]);
  });

  it('transmet la signature d’un protocole d’échéancier au cas d’usage de l’échéancier (R4)', async () => {
    let handler: ((envelope: EventEnvelope) => Promise<void>) | null = null;
    const consumer = {
      subscribe: async (_type: string, fn: (envelope: EventEnvelope) => Promise<void>) => {
        handler = fn;
      },
    } as unknown as RabbitMqConsumer;
    const mandates: unknown[] = [];
    const plans: unknown[] = [];
    const useCases = {
      recordMandateSignature: { execute: async (input: unknown) => mandates.push(input) },
      recordPlanSignature: {
        execute: async (input: unknown) => {
          plans.push(input);
          return 'recorded';
        },
      },
    } as unknown as RecoveryUseCases;
    await new MandateSignatureConsumer(consumer, useCases).onApplicationBootstrap();
    await handler!({
      eventId: 'e-2',
      type: 'document.signature.completed',
      version: 1,
      occurredAt: '2026-11-21T09:00:00.000Z',
      producer: 'document',
      correlationId: 'c-2',
      causationId: null,
      payload: {
        documentId: 'd-2',
        signatureRequestId: 's-2',
        template: 'recovery_settlement_agreement',
        templateVersion: 1,
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: 'case-1',
        ownerId: null,
        signerUserId: null,
        method: 'one_time_code',
        channel: 'whatsapp',
        documentSha256: 'a',
        signedFileId: 'f-2',
        signedDocumentSha256: 'b',
        signedAt: '2026-11-21T09:00:00.000Z',
      },
    } as EventEnvelope);
    expect(mandates).toEqual([]);
    expect(plans).toEqual([
      {
        eventId: 'e-2',
        documentId: 'd-2',
        template: 'recovery_settlement_agreement',
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: 'case-1',
        signedAt: '2026-11-21T09:00:00.000Z',
      },
    ]);
  });
});
