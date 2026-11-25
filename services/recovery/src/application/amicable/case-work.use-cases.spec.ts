import {
  activeCase,
  type AmicableWorld,
  amicableWorld,
  asAgent,
  asStaffNow,
  asSupervisor,
  at,
  caseOf,
} from '../testing/amicable-scenarios';
import { OTHER_AGENT_ID } from '../testing/case-scenarios';
import { asCreditor, rejection } from '../testing/fakes';

describe('travail du chargé sur un dossier (UC-RC-16, 18)', () => {
  let world: AmicableWorld;
  let caseId: string;
  let debtorId: string;

  beforeEach(async () => {
    world = amicableWorld();
    const record = await activeCase(world);
    caseId = record.id;
    debtorId = record.debtors[0]!.id;
  });

  const contact = (change: Record<string, string> = {}) =>
    asAgent(world, () =>
      world.useCases.recordContact.execute({
        caseId,
        idempotencyKey: 'contact-0001',
        debtorId,
        channel: 'phone',
        direction: 'outbound',
        outcome: 'reached',
        note: 'Le débiteur demande un délai',
        occurredAt: '',
        callbackAt: '',
        fileId: '',
        ...change,
      }),
    );

  describe('contact (RecordContact)', () => {
    it('entre au journal sans la note du chargé, une seule fois par clé', async () => {
      const first = await contact();
      const entry = first.entries[0]!.entry;
      expect(entry).toMatchObject({
        kind: 'contact',
        channel: 'phone',
        direction: 'outbound',
        outcome: 'reached',
        summary: 'Appel sortant : débiteur joint',
        actor: { type: 'agent' },
      });
      expect(entry.summary).not.toContain('délai');
      const again = await contact();
      expect(again.entries[0]!.entry.id).toBe(entry.id);
      expect(world.store.contacts.size).toBe(1);
      expect([...world.store.contacts.values()][0]).toMatchObject({
        note: 'Le débiteur demande un délai',
        debtorId,
      });
      expect(caseOf(world, caseId).lastActionAt).toEqual(world.deps.clock.current);
    });

    it('refuse un appel sortant hors des plages de contact, accepte un appel reçu la nuit', async () => {
      at(world, '2026-11-23T08:00:00.000Z');
      const refused = await rejection(contact({ occurredAt: '2026-11-22T10:00:00+01:00' }));
      expect(refused).toMatchObject({
        code: 'RECOVERY_CONTACT_OUTSIDE_HOURS',
        details: { nextAllowedAt: '2026-11-23T07:00:00.000Z' },
      });
      const inbound = await contact({
        idempotencyKey: 'contact-0002',
        direction: 'inbound',
        occurredAt: '2026-11-21T22:30:00+01:00',
      });
      expect(inbound.entries[0]!.entry.summary).toBe('Appel entrant : débiteur joint');
    });

    it('un rappel promis entre dans « Ma journée » jusqu’au prochain appel sortant', async () => {
      await contact({ outcome: 'callback_requested', callbackAt: '2026-11-23T10:00:00+01:00' });
      const friday = await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }));
      expect(friday.map((item) => item.kind)).toEqual([]);
      at(world, '2026-11-23T08:30:00.000Z');
      const monday = await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }));
      expect(monday).toEqual([
        expect.objectContaining({
          kind: 'promised_callback',
          dueAt: new Date('2026-11-23T09:00:00.000Z'),
          summary: expect.objectContaining({ summary: expect.objectContaining({ id: caseId }) }),
        }),
      ]);
      await contact({ idempotencyKey: 'contact-0003', occurredAt: '' });
      expect(await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }))).toEqual([]);
    });

    it('refuse un rappel promis hors plage et un dossier hors du périmètre du chargé', async () => {
      expect(await rejection(contact({ callbackAt: '2026-11-22T10:00:00+01:00' }))).toMatchObject({
        code: 'RECOVERY_CONTACT_OUTSIDE_HOURS',
        details: { nextAllowedAt: '2026-11-23T07:00:00.000Z' },
      });
      const other = await rejection(
        asStaffNow(world, OTHER_AGENT_ID, ['recovery_agent'], () =>
          world.useCases.addInternalNote.execute({ caseId, text: 'Note' }),
        ),
      );
      expect(other.code).toBe('RECOVERY_CASE_NOT_FOUND');
    });
  });

  describe('promesse (RecordPromise) et note interne', () => {
    const promise = (amount: number, dueDate: string, key = 'promise-0001') =>
      asAgent(world, () =>
        world.useCases.recordPromise.execute({ caseId, idempotencyKey: key, amount, dueDate, note: '' }),
      );

    it('enregistre la promesse et son entrée au journal ; refuse plus que le dû ou un jour passé', async () => {
      const recorded = await promise(100_000, '2026-11-30');
      expect(recorded).toMatchObject({ status: 'pending', amount: 100_000, dueDate: '2026-11-30' });
      expect(await promise(100_000, '2026-11-30')).toEqual(recorded);
      expect(world.deps.cases.evidence.at(-1)).toMatchObject({ kind: 'promise', amount: 100_000 });
      expect(await rejection(promise(800_000, '2026-11-30', 'promise-0002'))).toMatchObject({
        code: 'RECOVERY_VALIDATION_FAILED',
        details: { field: 'amount' },
      });
      expect((await rejection(promise(10_000, '2026-11-19', 'promise-0003'))).code).toBe(
        'RECOVERY_VALIDATION_FAILED',
      );
    });

    it('la note interne n’est jamais montrée au créancier', async () => {
      const note = await asSupervisor(world, () =>
        world.useCases.addInternalNote.execute({ caseId, text: 'Débiteur en difficulté passagère' }),
      );
      expect(note.entries[0]!.entry).toMatchObject({ kind: 'note', internal: true });
      const journal = await asCreditor(() =>
        world.useCases.listMyCaseJournal.execute({ caseId, page: { limit: 50 } }),
      );
      expect(journal.entries.map(({ entry }) => entry.kind)).not.toContain('note');
    });
  });

  describe('message au débiteur (SendDebtorMessage)', () => {
    const send = (change: Record<string, string> = {}) =>
      asAgent(world, () =>
        world.useCases.sendDebtorMessage.execute({
          caseId,
          idempotencyKey: 'message-0001',
          debtorId: '',
          template: 'reminder',
          channel: '',
          ...change,
        }),
      );

    it('envoie le modèle avec un lien neuf, par le premier canal réglé, et l’écrit au journal', async () => {
      const view = await send();
      expect(world.notifier.sent).toHaveLength(1);
      const sent = world.notifier.sent[0]!;
      expect(sent).toMatchObject({
        message: 'reminder',
        channel: 'email',
        email: 'compta@negoce.bj',
        variables: {
          creditor_name: 'Awa Dossou',
          case_number: 'RC-000001',
          amount_due: '750 000 FCFA',
          link: expect.stringMatching(/^https:\/\/ksp\.bj\/recouvrement\/[A-Za-z0-9_-]{43}$/),
        },
      });
      expect(sent.idempotencyKey).toMatch(/^manual:/);
      expect(view.entries[0]!.entry).toMatchObject({
        kind: 'message_sent',
        channel: 'email',
        direction: 'outbound',
        deliveryStatus: 'sent',
        actor: { type: 'agent' },
      });
      expect(JSON.stringify(view.entries[0]!.entry)).not.toContain('negoce');
      // Rejeu : rien ne repart.
      expect((await send()).entries[0]!.entry.id).toBe(view.entries[0]!.entry.id);
      expect(world.notifier.sent).toHaveLength(1);
    });

    it('renouvelle le lien à chaque message : le précédent est révoqué', async () => {
      await send();
      const store = world.deps.debtorAccess.store;
      const first = store.activeOf(debtorId)!;
      await send({ idempotencyKey: 'message-0002', template: 'payment_link', channel: 'whatsapp' });
      const second = store.activeOf(debtorId)!;
      expect(second.id).not.toBe(first.id);
      expect(
        [...store.rows.values()].find((row) => row.access.id === first.id)!.access.link.revokedAt,
      ).not.toBeNull();
      expect(world.notifier.sent[1]).toMatchObject({
        message: 'payment_link',
        channel: 'whatsapp',
        phone: expect.any(String),
      });
    });

    it('refuse le SMS, hors plage, et le rappel d’échéance sans échéancier', async () => {
      expect(await rejection(send({ channel: 'sms' }))).toMatchObject({ details: { field: 'channel' } });
      expect(await rejection(send({ template: 'plan_reminder' }))).toMatchObject({
        details: { field: 'template' },
      });
      at(world, '2026-11-22T10:00:00.000Z');
      expect(await rejection(send())).toMatchObject({
        code: 'RECOVERY_CONTACT_OUTSIDE_HOURS',
        details: { nextAllowedAt: '2026-11-23T07:00:00.000Z' },
      });
      expect(world.notifier.sent).toHaveLength(0);
    });
  });
});
