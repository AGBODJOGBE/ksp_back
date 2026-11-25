import {
  activeCase,
  type AmicableWorld,
  amicableWorld,
  asAgent,
  asSupervisor,
  at,
  caseOf,
  collect,
  eventsOf,
} from '../testing/amicable-scenarios';
import { caseInput, FILE_2 } from '../testing/case-scenarios';
import { NOW } from '../testing/fakes';

/** 750 000 FCFA : 75 000 le 30 novembre, puis 5 mensualités de 135 000 (dans le barème B2B). */
const IN_SCALE = { firstAmount: 75_000, firstDueDate: '2026-11-30', rhythm: 'monthly', installmentsCount: 5 };

describe('tâche de la procédure amiable (UC-RC-15, 18, 26, 27)', () => {
  let world: AmicableWorld;
  let caseId: string;
  let debtorId: string;

  const run = () => world.useCases.watchAmicable.execute();
  const messages = (purpose?: string) =>
    [...world.store.messages.values()].filter((message) => !purpose || message.purpose === purpose);
  const evidence = (action: string) =>
    world.deps.cases.evidence.filter((entry) => entry.caseId === caseId && entry.action === action);

  async function start(instant?: string, change: Parameters<typeof activeCase>[2] = {}) {
    world = amicableWorld();
    if (instant) at(world, instant);
    const record = await activeCase(world, 'case-key-0001', change);
    caseId = record.id;
    debtorId = record.debtors[0]!.id;
  }

  describe('premier contact : notification du mandat (étape 1, R-DB-02)', () => {
    it('part dans la plage de contact, par le premier canal réglé, avec le lien personnel', async () => {
      await start();
      expect(await run()).toMatchObject({ noticesQueued: 1, messagesSent: 1, failed: 0 });
      expect(world.notifier.sent).toEqual([
        expect.objectContaining({
          message: 'mandate_notice',
          channel: 'email',
          email: 'compta@negoce.bj',
          variables: expect.objectContaining({
            creditor_name: 'Awa Dossou',
            case_number: 'RC-000001',
            amount_due: '750 000 FCFA',
            link: expect.stringMatching(/^https:\/\/ksp\.bj\/recouvrement\//),
            link_expires_on: '20 décembre 2026',
          }),
          idempotencyKey: expect.stringMatching(new RegExp(`^notice:${caseId}:`)),
        }),
      ]);
      expect(world.deps.debtorAccess.store.activeOf(debtorId)).toBeDefined();
      expect(evidence('message.notice')).toEqual([
        expect.objectContaining({
          kind: 'message_sent',
          channel: 'email',
          direction: 'outbound',
          deliveryStatus: 'sent',
        }),
      ]);
      expect(JSON.stringify(world.deps.cases.events)).not.toContain('negoce');
      expect(await run()).toMatchObject({ noticesQueued: 0, messagesSent: 0 });
      expect(world.notifier.sent).toHaveLength(1);
    });

    it('accepté un samedi soir avant un lundi férié : attend le mardi 8 h', async () => {
      await start('2026-11-21T19:00:00.000Z');
      world.deps.holidays.days.set('2026-11-23', 'Jour férié');
      expect(await run()).toMatchObject({ noticesQueued: 1, messagesSent: 0 });
      at(world, '2026-11-22T10:00:00.000Z');
      expect((await run()).messagesSent).toBe(0);
      at(world, '2026-11-23T10:00:00.000Z');
      expect((await run()).messagesSent).toBe(0);
      at(world, '2026-11-24T06:59:00.000Z');
      expect((await run()).messagesSent).toBe(0);
      at(world, '2026-11-24T07:00:00.000Z');
      expect((await run()).messagesSent).toBe(1);
      expect(messages('notice')[0]).toMatchObject({
        status: 'sent',
        sentAt: new Date('2026-11-24T07:00:00.000Z'),
      });
    });

    it('débiteur sans e-mail : WhatsApp ; sans coordonnée pour l’ordre réglé : échec tracé', async () => {
      await start(undefined, { debtors: [{ ...caseInput().debtors[0]!, emails: [] }] });
      await run();
      expect(world.notifier.sent[0]).toMatchObject({
        channel: 'whatsapp',
        phone: expect.stringMatching(/^\+229/),
        email: null,
      });

      await start();
      world.deps.amicableOptions = { debtorChannels: ['whatsapp'] };
      // Débiteur sans téléphone valable : l'ordre « whatsapp » seul ne trouve aucune coordonnée.
      caseOf(world, caseId).debtors[0]!.contacts = caseOf(world, caseId).debtors[0]!.contacts.filter(
        (contact) => contact.channel === 'email',
      );
      expect(await run()).toMatchObject({ messagesFailed: 1, messagesSent: 0 });
      expect(messages('notice')[0]!.status).toBe('failed');
      expect(evidence('message.notice.failed')).toEqual([expect.objectContaining({ internal: true })]);
    });

    it('notification en panne : reprise après la réservation, en échec après 5 essais', async () => {
      await start();
      world.notifier.failure = new Error('notification injoignable');
      expect(await run()).toMatchObject({ messagesSent: 0, failed: 1 });
      expect(messages('notice')[0]).toMatchObject({ status: 'pending', attempts: 1 });
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        at(world, new Date(NOW.getTime() + attempt * 6 * 60_000).toISOString());
        await run();
      }
      expect(messages('notice')[0]).toMatchObject({ status: 'failed', attempts: 5 });
      world.notifier.failure = null;
      // Sans notification remise, le délai de réponse court depuis l'acceptation.
      at(world, '2026-11-28T10:00:00.000Z');
      await run();
      expect(caseOf(world, caseId).stage).toBe('amicable');
    });

    it('un message en file d’un dossier suspendu est annulé', async () => {
      await start('2026-11-21T19:00:00.000Z');
      await run();
      caseOf(world, caseId).status = 'suspended';
      at(world, '2026-11-23T09:00:00.000Z');
      expect(await run()).toMatchObject({ messagesCancelled: 1, messagesSent: 0 });
      expect(messages('notice')[0]!.status).toBe('cancelled');
    });
  });

  describe('avancement et relance amiable (étapes 1 et 3, UC-RC-18)', () => {
    it('sans réponse en 8 jours : relance amiable, message J0 avec un lien renouvelé, appels au chargé', async () => {
      await start();
      await run();
      const firstLink = world.deps.debtorAccess.store.activeOf(debtorId)!;
      at(world, '2026-11-28T08:59:00.000Z');
      expect((await run()).stagesAdvanced).toBe(0);
      at(world, '2026-11-28T09:00:00.000Z');
      expect(await run()).toMatchObject({ stagesAdvanced: 1, messagesSent: 1 });
      expect(caseOf(world, caseId).stage).toBe('amicable');
      expect(eventsOf(world, 'recovery.case.stage_changed').at(-1)!.payload).toMatchObject({
        fromStage: 'notice',
        toStage: 'amicable',
        changedBy: 'system',
      });
      expect(world.notifier.sent.at(-1)).toMatchObject({ message: 'reminder' });
      expect(world.deps.debtorAccess.store.activeOf(debtorId)!.id).not.toBe(firstLink.id);

      // J3 : appel à passer, soldé par l'appel sortant du chargé.
      at(world, '2026-12-01T09:00:00.000Z');
      const queue = await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }));
      expect(queue).toEqual([
        expect.objectContaining({ kind: 'reminder_due', note: 'Appel de relance amiable (J3)' }),
      ]);
      await asAgent(world, () =>
        world.useCases.recordContact.execute({
          caseId,
          idempotencyKey: 'contact-j3-0001',
          debtorId,
          channel: 'phone',
          direction: 'outbound',
          outcome: 'no_answer',
          note: '',
          occurredAt: '',
          callbackAt: '',
          fileId: '',
        }),
      );
      expect(await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }))).toEqual([]);

      // J7 : e-mail de relance, seul (le débiteur a un e-mail).
      at(world, '2026-12-05T09:00:00.000Z');
      await run();
      expect(
        messages('amicable_step').map((message) => [
          message.dedupeKey.split(':').at(-1),
          message.channel,
          message.status,
        ]),
      ).toEqual([
        ['0', 'email', 'sent'],
        ['2', 'email', 'sent'],
      ]);
      at(world, '2026-12-12T09:00:00.000Z');
      expect(
        (await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }))).map(
          (item) => item.note,
        ),
      ).toEqual(['Appel de relance amiable (J14)']);

      // Fin de la relance amiable (21 jours) : mise en demeure proposée au superviseur, une fois.
      at(world, '2026-12-19T09:00:00.000Z');
      expect((await run()).escalationsProposed).toBe(1);
      expect((await run()).escalationsProposed).toBe(0);
      expect(caseOf(world, caseId).stage).toBe('amicable');
      expect(evidence('stage.escalation_proposed')).toHaveLength(1);
    });

    it('un échéancier en cours d’accord retient le dossier à la notification', async () => {
      await start();
      await run();
      await world.useCases.proposeDebtorPaymentPlan.execute({
        caseId,
        debtorId,
        idempotencyKey: 'plan-key-0001',
        terms: { ...IN_SCALE, firstAmount: 30_000 },
        message: '',
      });
      at(world, '2026-11-29T09:00:00.000Z');
      expect((await run()).stagesAdvanced).toBe(0);
      expect(caseOf(world, caseId).stage).toBe('notice');
    });
  });

  describe('échéancier signé (étape 2, R-EC-03)', () => {
    async function signedPlan() {
      const plan = await world.useCases.proposeDebtorPaymentPlan.execute({
        caseId,
        debtorId,
        idempotencyKey: 'plan-key-0001',
        terms: IN_SCALE,
        message: '',
      });
      await world.useCases.recordPlanSignature.execute({
        eventId: '0192f1c4-0000-7000-8000-00000000e001',
        documentId: plan.documentId!,
        template: 'recovery_settlement_agreement',
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: caseId,
        signedAt: NOW.toISOString(),
      });
      return plan;
    }

    it('rappels 3 jours avant et le jour, paiement déduit des encaissements, rupture à 2 échéances manquées', async () => {
      await start();
      const plan = await signedPlan();
      await run();
      expect(messages('plan_confirmed')[0]!.status).toBe('sent');

      at(world, '2026-11-27T09:00:00.000Z');
      await run();
      at(world, '2026-11-30T09:00:00.000Z');
      await run();
      expect(
        messages('installment_reminder').map((message) => [
          message.dedupeKey.split(':').at(-1),
          message.variables,
        ]),
      ).toEqual([
        ['before', { amount: '75 000 FCFA', due_on: '30 novembre 2026' }],
        ['due_day', { amount: '75 000 FCFA', due_on: '30 novembre 2026' }],
      ]);
      expect(world.notifier.sent.filter((sent) => sent.message === 'installment_reminder')).toHaveLength(2);

      collect(world, caseId, 75_000);
      await run();
      expect(world.store.planRows.get(plan.id)!.installments[0]).toMatchObject({
        paidAmount: 75_000,
        status: 'paid',
      });

      // Échéance du 30 décembre impayée : manquée après 5 jours de grâce.
      at(world, '2027-01-04T09:00:00.000Z');
      expect((await run()).installmentsMissed).toBe(0);
      at(world, '2027-01-05T09:00:00.000Z');
      expect((await run()).installmentsMissed).toBe(1);
      expect(eventsOf(world, 'recovery.plan.installment_missed').map((event) => event.payload)).toEqual([
        expect.objectContaining({
          planId: plan.id,
          installmentRank: 2,
          dueDate: '2026-12-30',
          missedCount: 1,
          amount: { amount: 135_000, currency: 'XOF' },
        }),
      ]);
      expect(
        (await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }))).map(
          (item) => item.kind,
        ),
      ).toEqual(['missed_installment']);

      at(world, '2027-02-05T09:00:00.000Z');
      expect(await run()).toMatchObject({ installmentsMissed: 1, plansDefaulted: 1, stagesAdvanced: 1 });
      expect(world.store.planRows.get(plan.id)!.status).toBe('defaulted');
      expect(eventsOf(world, 'recovery.plan.defaulted').map((event) => event.payload)).toEqual([
        expect.objectContaining({ planId: plan.id, missedCount: 2 }),
      ]);
      expect(caseOf(world, caseId).stage).toBe('amicable');
      // La relance amiable commence aussitôt : message J0.
      expect(messages('amicable_step')).toEqual([expect.objectContaining({ status: 'sent' })]);
    });

    it('dossier clos (accord exécuté, abandon) : échéancier arrêté sans échéance manquée', async () => {
      await start();
      const plan = await signedPlan();
      caseOf(world, caseId).status = 'closed';
      at(world, '2027-02-10T09:00:00.000Z');
      expect(await run()).toMatchObject({ installmentsMissed: 0, plansDefaulted: 0 });
      expect(world.store.planRows.get(plan.id)!.status).toBe('cancelled');
      expect(eventsOf(world, 'recovery.plan.installment_missed')).toEqual([]);
    });

    it('soldé par les encaissements : échéancier terminé, plus aucun rappel', async () => {
      await start();
      const plan = await signedPlan();
      collect(world, caseId, 750_000);
      expect((await run()).plansCompleted).toBe(1);
      expect(world.store.planRows.get(plan.id)!.status).toBe('completed');
      at(world, '2026-11-27T09:00:00.000Z');
      await run();
      expect(messages('installment_reminder')).toEqual([]);
    });
  });

  describe('promesses (R-PR-09)', () => {
    const promise = (amount: number, dueDate: string, key: string) =>
      asAgent(world, () =>
        world.useCases.recordPromise.execute({ caseId, idempotencyKey: key, amount, dueDate, note: '' }),
      );

    it('tenue par les encaissements ; non tenue le lendemain : relance du débiteur et « Ma journée »', async () => {
      await start();
      const kept = await promise(50_000, '2026-11-24', 'promise-0001');
      const late = await promise(100_000, '2026-11-25', 'promise-0002');
      at(world, '2026-11-24T09:00:00.000Z');
      collect(world, caseId, 60_000);
      expect(await run()).toMatchObject({ promisesKept: 1, promisesBroken: 0 });
      expect(world.store.promiseRows.get(kept.id)!.status).toBe('kept');
      // 60 000 reçus ne tiennent pas la promesse de 100 000 : elle attend son jour.
      expect(world.store.promiseRows.get(late.id)!.status).toBe('pending');

      at(world, '2026-11-25T22:00:00.000Z');
      expect((await run()).promisesBroken).toBe(0);
      at(world, '2026-11-26T09:00:00.000Z');
      expect(await run()).toMatchObject({ promisesBroken: 1, messagesSent: 1 });
      expect(world.store.promiseRows.get(late.id)).toMatchObject({
        status: 'broken',
        brokenAt: world.deps.clock.current,
      });
      expect(messages('promise_followup')).toEqual([
        expect.objectContaining({ status: 'sent', message: 'reminder' }),
      ]);
      expect(
        (await asAgent(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }))).map(
          (item) => item.kind,
        ),
      ).toEqual(['broken_promise']);
    });
  });

  describe('décisions et remises échues (R-EC-01, R-PR-05)', () => {
    it('sans réponse du créancier en 3 jours : échéancier hors barème et remise refusés', async () => {
      await start();
      const plan = await world.useCases.proposeDebtorPaymentPlan.execute({
        caseId,
        debtorId,
        idempotencyKey: 'plan-key-0001',
        terms: { ...IN_SCALE, firstAmount: 30_000 },
        message: '',
      });
      await asSupervisor(world, () =>
        world.useCases.approvePaymentPlan.execute({ planId: plan.id, decision: 'approve', note: '' }),
      );
      const settlement = await asAgent(world, () =>
        world.useCases.proposeSettlement.execute({
          caseId,
          idempotencyKey: 'settle-0001',
          payNow: 700_000,
          validUntil: '2026-12-10',
          note: '',
        }),
      );
      at(world, '2026-11-23T08:59:00.000Z');
      expect((await run()).decisionsExpired).toBe(0);
      at(world, '2026-11-23T09:00:00.000Z');
      expect((await run()).decisionsExpired).toBe(2);
      expect(world.store.planRows.get(plan.id)!.status).toBe('rejected');
      expect(world.store.settlementRows.get(settlement.id)!.status).toBe('rejected');
      expect([...world.store.decisionRows.values()].map((decision) => decision.status)).toEqual([
        'expired',
        'expired',
      ]);
      expect(evidence('decision.expired')).toHaveLength(2);
    });

    it('une remise offerte expire après sa date de validité', async () => {
      await start(undefined, {
        claims: [{ reference: 'F-88', amount: 500_000, dueDate: '2026-10-01', description: '' }],
        evidenceFileIds: [FILE_2],
        planScale: {
          acceptsPaymentPlan: true,
          maxDurationMonths: 12,
          minFirstPaymentBps: 1_000,
          firstPaymentWithinDays: 15,
          minInstallment: 25_000,
          maxDiscountBps: 1_000,
        },
      });
      const settlement = await asAgent(world, () =>
        world.useCases.proposeSettlement.execute({
          caseId,
          idempotencyKey: 'settle-0001',
          payNow: 450_000,
          validUntil: '2026-11-25',
          note: '',
        }),
      );
      at(world, '2026-11-25T22:00:00.000Z');
      expect((await run()).settlementsExpired).toBe(0);
      at(world, '2026-11-26T09:00:00.000Z');
      expect((await run()).settlementsExpired).toBe(1);
      expect(world.store.settlementRows.get(settlement.id)!.status).toBe('expired');
    });
  });
});
