import { asAgent, asSupervisor } from '../testing/amicable-scenarios';
import { rejection } from '../testing/fakes';
import {
  asLegal,
  caseAtFormalNotice,
  caseOf,
  LEGAL_OFFICER_ID,
  litigationWorld,
} from '../testing/litigation-scenarios';

interface Generated {
  variables: {
    entries: { at: string; action: string; actor: string; outcome?: string }[];
    part?: { index: number; total: number; from: string; to: string };
    currentStage: string;
  };
}

describe('journal de preuve exporté (ExportCaseJournal, R-PR-08)', () => {
  it('exporte le journal sans les notes internes, dans l’ordre, rejouable avec la même clé', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    await asAgent(world, () =>
      world.useCases.addInternalNote.execute({ caseId: record.id, text: 'Débiteur difficile à joindre' }),
    );
    const exported = await asLegal(world, () =>
      world.useCases.exportCaseJournal.execute({ caseId: record.id, idempotencyKey: 'export-0001' }),
    );
    const generated = [...world.documents.generated.values()].find(
      (document) => document.id === exported.documentId,
    ) as unknown as Generated;
    const entries = generated.variables.entries;
    expect(entries.length).toBe(
      world.deps.cases.evidence.filter((e) => e.caseId === record.id && !e.internal).length - 1,
    );
    expect(entries.some((entry) => entry.outcome?.includes('Débiteur difficile'))).toBe(false);
    expect([...entries].sort((a, b) => a.at.localeCompare(b.at))).toEqual(entries);
    expect(generated.variables.part).toBeUndefined();
    expect(generated.variables.currentStage).toBe('Mise en demeure');
    expect(entries.find((entry) => entry.actor === 'Awa Dossou, créancier')).toBeDefined();
    expect(caseOf(world, record.id).documents.find((d) => d.kind === 'evidence_log')).toMatchObject({
      documentId: exported.documentId,
      visibleToPartner: true,
      visibleToDebtor: false,
    });
    expect(world.deps.cases.audit.find((entry) => entry.action === 'case.journal_exported')).toMatchObject({
      actorId: LEGAL_OFFICER_ID,
    });
    const again = await asLegal(world, () =>
      world.useCases.exportCaseJournal.execute({ caseId: record.id, idempotencyKey: 'export-0001' }),
    );
    expect(again.documentId).toBe(exported.documentId);
    expect(caseOf(world, record.id).documents.filter((d) => d.kind === 'evidence_log')).toHaveLength(1);
    expect(
      await rejection(
        asAgent(world, () =>
          world.useCases.exportCaseJournal.execute({ caseId: record.id, idempotencyKey: 'export-0002' }),
        ),
      ),
    ).toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });

  it('découpe le journal par période au-delà de 1 000 entrées (variable part)', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const start = new Date('2026-11-20T10:00:00.000Z').getTime();
    for (let index = 0; index < 1_500; index += 1) {
      world.deps.cases.evidence.push({
        id: `0192f1c4-0000-7000-8000-${(0xe0000 + index).toString(16).padStart(12, '0')}`,
        caseId: record.id,
        occurredAt: new Date(start + index * 60_000),
        actor: { type: 'system', id: null },
        action: 'message.reminder',
        kind: 'message_sent',
        summary: `Relance n° ${index + 1} envoyée par WhatsApp`,
        channel: 'whatsapp',
        direction: 'outbound',
        outcome: null,
        deliveryStatus: 'delivered',
        amount: null,
        internal: false,
        ref: null,
      });
    }
    const exported = await asSupervisor(world, () =>
      world.useCases.exportCaseJournal.execute({ caseId: record.id, idempotencyKey: 'export-0001' }),
    );
    const parts = [...world.documents.generated.values()]
      .map((document) => document as unknown as Generated & { id: string })
      .filter((document) => document.variables.entries !== undefined);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.id).toBe(exported.documentId);
    expect(parts.map((part) => [part.variables.part?.index, part.variables.part?.total])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(parts[0]?.variables.entries).toHaveLength(1_000);
    expect(parts[0]?.variables.part?.to).toBe(parts[0]?.variables.entries.at(-1)?.at);
    expect(parts[1]?.variables.entries[0]).toMatchObject({
      channel: 'WhatsApp',
      delivery: 'delivered',
      actor: 'Système',
    });
    expect(
      caseOf(world, record.id)
        .documents.filter((d) => d.kind === 'evidence_log')
        .map((d) => d.label.endsWith('(partie 1/2)') || d.label.endsWith('(partie 2/2)')),
    ).toEqual([true, true]);
  });
});
