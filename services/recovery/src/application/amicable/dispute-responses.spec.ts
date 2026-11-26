import {
  activeCase,
  type AmicableWorld,
  amicableWorld,
  asLegal,
  at,
  caseOf,
  eventsOf,
} from '../testing/amicable-scenarios';
import { type MemoryMoneyStore } from '../testing/money-fakes';
import { asCreditor, rejection } from '../testing/fakes';
import { type DecisionRecord } from './amicable.ports';
import { disputeResponseId } from './dispute-responses';

describe('réponse du créancier à une contestation (R-PR-02, décision dispute_response)', () => {
  let world: AmicableWorld;
  let caseId: string;
  let debtorId: string;

  beforeEach(async () => {
    world = amicableWorld();
    const record = await activeCase(world);
    caseId = record.id;
    debtorId = record.debtors[0]!.id;
  });

  const dispute = (key = 'dispute-key-0001') =>
    world.useCases.disputeDebtorCase.execute({
      caseId,
      debtorId,
      idempotencyKey: key,
      reason: 'already_paid',
      text: 'Déjà réglé en espèces',
      fileIds: [],
    });
  const decisionOf = (disputeId: string) => world.store.decisionRows.get(disputeResponseId(disputeId));
  const answer = (decisionId: string, key = 'answer-key-0001') =>
    asCreditor(() =>
      world.useCases.answerDecision.execute({
        decisionId,
        idempotencyKey: key,
        answer: 'answer',
        comment: 'Aucun paiement reçu',
        fileIds: [],
      }),
    );
  const resolve = (disputeId: string, resolution: 'resume' | 'close') =>
    asLegal(world, () =>
      world.useCases.resolveDispute.execute({
        caseId,
        disputeId,
        resolution,
        correctedDue: null,
        note: 'Pièces examinées',
      }),
    );

  it('demandée au créancier à l’ouverture, une seule fois, avec l’échéance de la contestation', async () => {
    const opened = await dispute();
    expect(caseOf(world, caseId).status).toBe('suspended');
    const decision = decisionOf(opened.id)!;
    expect(decision).toMatchObject({
      caseId,
      kind: 'dispute_response',
      status: 'pending',
      payload: { disputeId: opened.id },
      requestedAt: opened.openedAt,
      expiresAt: opened.creditorAnswerDueAt,
    });
    expect(eventsOf(world, 'recovery.decision.requested').map((event) => event.payload)).toEqual([
      expect.objectContaining({ decisionId: decision.id, kind: 'dispute_response', caseId }),
    ]);

    // Rejouée par le débiteur : même contestation, aucune nouvelle demande.
    expect((await dispute()).id).toBe(opened.id);
    expect([...world.store.decisionRows.values()].filter((d) => d.kind === 'dispute_response')).toHaveLength(
      1,
    );
    expect(eventsOf(world, 'recovery.decision.requested')).toHaveLength(1);
  });

  it('rejouée après un échec de la demande : la décision est créée', async () => {
    world.store.staleCommits = 1;
    expect(await rejection(dispute())).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
    const opened = (await (world.deps.money as MemoryMoneyStore).disputes(caseId))[0]!;
    expect(decisionOf(opened.id)).toBeUndefined();
    await dispute();
    expect(decisionOf(opened.id)).toMatchObject({ status: 'pending' });
  });

  it('répondue par le créancier, puis tranchée par le juriste : le dossier reprend', async () => {
    const opened = await dispute();
    const decisionId = decisionOf(opened.id)!.id;
    const result = await answer(decisionId);
    expect(result.decision.decision).toMatchObject({ status: 'answered' });
    expect(result.decision.dispute).toMatchObject({
      dispute: { id: opened.id, status: 'creditor_answered' },
      answer: { comment: 'Aucun paiement reçu', fileIds: [] },
    });
    expect(world.deps.cases.evidence.at(-1)).toMatchObject({
      action: 'decision.answered',
      summary: 'Réponse du créancier à la contestation : décision du juriste à suivre',
    });
    await resolve(opened.id, 'resume');
    expect(caseOf(world, caseId).status).toBe('active');
    expect(decisionOf(opened.id)!.status).toBe('answered');
  });

  it('tranchée avant la réponse : la demande est close, le créancier ne peut plus répondre', async () => {
    const opened = await dispute();
    const decisionId = decisionOf(opened.id)!.id;
    await resolve(opened.id, 'resume');
    expect(decisionOf(opened.id)).toMatchObject({ status: 'expired', decidedAt: world.deps.clock.current });
    expect(world.deps.cases.evidence.some((entry) => entry.action === 'decision.closed')).toBe(true);
    expect(await rejection(answer(decisionId))).toMatchObject({ code: 'RECOVERY_DECISION_CLOSED' });
  });

  it('sans réponse à l’échéance : la tâche l’expire et le juriste décide', async () => {
    const opened = await dispute();
    at(world, new Date(opened.creditorAnswerDueAt.getTime() + 60_000).toISOString());
    const report = await world.useCases.watchAmicable.execute();
    expect(report.decisionsExpired).toBe(1);
    expect(decisionOf(opened.id)!.status).toBe('expired');
    expect(world.deps.cases.evidence.at(-1)).toMatchObject({
      action: 'decision.expired',
      summary: 'Contestation sans réponse du créancier dans le délai : le juriste décide',
    });
    expect(caseOf(world, caseId).status).toBe('suspended');
  });

  it('une demande restée ouverte d’une contestation précédente est close par la nouvelle', async () => {
    const leftover: DecisionRecord = {
      id: '0192f1c4-0000-7000-8000-0000000d1500',
      caseId,
      kind: 'dispute_response',
      status: 'pending',
      payload: { disputeId: '0192f1c4-0000-7000-8000-0000000d1501' },
      requestedBy: null,
      requestedAt: world.deps.clock.current,
      expiresAt: new Date(world.deps.clock.current.getTime() + 86_400_000),
      decidedAt: null,
      decidedBy: null,
      answer: null,
    };
    world.store.decisionRows.set(leftover.id, leftover);
    const opened = await dispute();
    expect(world.store.decisionRows.get(leftover.id)!.status).toBe('expired');
    expect(decisionOf(opened.id)!.status).toBe('pending');
  });
});
