import {
  asOrgViewer,
  asOtherCreditor,
  caseInput,
  caseWorld,
  type CaseWorld,
  createDraft,
  FILE_1,
  FILE_2,
  FILE_3,
  signMandate,
  submittedCase,
} from '../testing/case-scenarios';
import { asCreditor, CREDITOR_ID, NOW, ORGANIZATION_ID, rejection } from '../testing/fakes';
import { caseFeeKey } from './case-fees';

describe('dossiers du créancier (R2 : UC-RC-01, 03, 04, 05)', () => {
  let world: CaseWorld;

  beforeEach(() => {
    world = caseWorld();
  });

  describe('création d’un brouillon (CreateCase)', () => {
    it('crée le dossier numéroté, ses débiteurs, créances et pièces, montant dû tenu à jour', async () => {
      const result = await createDraft(world);
      const record = result.view.record;
      expect(result.created).toBe(true);
      expect(record).toMatchObject({
        number: 'RC-000001',
        status: 'draft',
        kind: 'b2b',
        source: 'form',
        principal: 750_000,
        paid: 0,
        earliestDueDate: '2026-09-30',
        communeKey: 'cotonou',
        preserveRelationship: true,
        creditor: { type: 'user', id: CREDITOR_ID },
      });
      expect(result.view.amounts.due).toBe(750_000);
      expect(record.debtors[0]!.contacts).toEqual([
        expect.objectContaining({ channel: 'phone', value: '+2290197000101', isPrimary: true }),
        expect.objectContaining({ channel: 'email', value: 'compta@negoce.bj', isPrimary: true }),
      ]);
      expect(record.documents).toEqual([expect.objectContaining({ kind: 'evidence', fileId: FILE_1 })]);
      expect(world.files.subjects.get(FILE_1)).toEqual({ type: 'recovery_case', id: record.id });
      expect(result.view.nextDeadline).toEqual({
        kind: 'fee_payment',
        dueAt: new Date(NOW.getTime() + 7 * 86_400_000),
      });
      expect(world.deps.cases.evidence.map((entry) => entry.action)).toEqual(['case.created']);
      // Aucune coordonnée du débiteur dans le journal de preuve.
      expect(JSON.stringify(world.deps.cases.evidence)).not.toMatch(/Négoce|97000101|negoce\.bj/);
    });

    it('rejeu de la même clé : même dossier ; autre saisie avec la même clé : refusée', async () => {
      const first = await createDraft(world);
      const again = await createDraft(world);
      expect(again).toMatchObject({ created: false, view: { record: { id: first.view.record.id } } });
      expect(world.deps.cases.cases.size).toBe(1);
      const error = await rejection(createDraft(world, 'case-key-0001', { interests: 10_000 }));
      expect(error.code).toBe('RECOVERY_IDEMPOTENCY_KEY_REUSED');
    });

    it('signale un dossier ouvert semblable (même débiteur, même référence) sans bloquer (R-SD-06)', async () => {
      const first = await createDraft(world);
      const second = await createDraft(world, 'case-key-0002', {
        claims: [{ reference: 'F-2026-001', amount: 300_000, dueDate: '2026-09-30', description: '' }],
        evidenceFileIds: [FILE_2],
      });
      expect(second.created).toBe(true);
      expect(second.duplicates.map((item) => item.summary.id)).toEqual([first.view.record.id]);
      const other = await createDraft(world, 'case-key-0003', {
        claims: [{ reference: 'F-2026-777', amount: 300_000, dueDate: '2026-09-30', description: '' }],
        evidenceFileIds: [FILE_3],
      });
      expect(other.duplicates).toEqual([]);
    });

    it('répartit les paiements déjà reçus sur les créances et contrôle le minimum (R-SD-05)', async () => {
      const result = await createDraft(world, 'case-key-0001', { interests: 20_000, alreadyPaid: 350_000 });
      expect(result.view.record.claims.map((claim) => claim.paidBefore)).toEqual([300_000, 50_000]);
      expect(result.view.amounts).toMatchObject({
        principal: 750_000,
        interests: 20_000,
        paid: 350_000,
        due: 420_000,
      });
      const below = await rejection(
        createDraft(world, 'case-key-0002', {
          claims: [{ reference: 'X-1', amount: 20_000, dueDate: '2026-10-01', description: '' }],
          evidenceFileIds: [FILE_2],
        }),
      );
      expect(below).toMatchObject({
        code: 'RECOVERY_AMOUNT_BELOW_MINIMUM',
        details: { minimum: { amount: 25_000 } },
      });
    });

    it.each([
      [
        'un débiteur sans contact',
        { debtors: [{ ...caseInput().debtors[0]!, phones: [], emails: [] }] },
        'debtors[0].phones',
      ],
      [
        'un téléphone illisible',
        { debtors: [{ ...caseInput().debtors[0]!, phones: ['12'] }] },
        'debtors[0].phones[0]',
      ],
      [
        'une échéance pas encore atteinte',
        { claims: [{ reference: 'F-9', amount: 100_000, dueDate: '2026-12-31', description: '' }] },
        'claims[0].dueDate',
      ],
      [
        'deux références identiques',
        {
          claims: [
            { reference: 'F-1', amount: 100_000, dueDate: '2026-10-01', description: '' },
            { reference: 'f-1', amount: 100_000, dueDate: '2026-10-01', description: '' },
          ],
        },
        'claims[1].reference',
      ],
      [
        'deux débiteurs principaux',
        { debtors: [caseInput().debtors[0]!, { ...caseInput().debtors[0]!, legalName: 'Autre' }] },
        'debtors',
      ],
      ['aucune pièce', { evidenceFileIds: [] }, 'evidenceFileIds'],
      ['un dossier de loyers', { kind: 'rent' }, 'kind'],
      ['des paiements au-delà de la créance', { alreadyPaid: 900_000 }, 'amount'],
    ])('refuse %s (RECOVERY_VALIDATION_FAILED)', async (_label, change, field) => {
      const error = await rejection(createDraft(world, 'case-key-0001', change));
      expect(error).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field } });
      expect(world.deps.cases.cases.size).toBe(0);
    });

    it('organisation : un membre lecteur consulte mais ne crée pas ; le barème préféré est copié', async () => {
      const error = await rejection(
        asOrgViewer(ORGANIZATION_ID, () =>
          world.useCases.createCase.execute({ idempotencyKey: 'case-key-0001', input: caseInput() }),
        ),
      );
      expect(error.code).toBe('AUTH_FORBIDDEN');
      const scale = {
        acceptsPaymentPlan: true,
        maxDurationMonths: 4,
        minFirstPaymentBps: 2_000,
        firstPaymentWithinDays: 10,
        minInstallment: 30_000,
        maxDiscountBps: 500,
      };
      await asCreditor(
        () =>
          world.useCases.updateMyPreferences.execute({ b2bScale: scale, b2cScale: scale, notifyUserIds: [] }),
        ORGANIZATION_ID,
      );
      const created = await asCreditor(
        () => world.useCases.createCase.execute({ idempotencyKey: 'case-key-0001', input: caseInput() }),
        ORGANIZATION_ID,
      );
      expect(created.view.record.creditor).toEqual({ type: 'organization', id: ORGANIZATION_ID });
      expect(created.view.planScale).toEqual(scale);
      const listed = await asOrgViewer(ORGANIZATION_ID, () =>
        world.useCases.listMyCases.execute({ statuses: [], stages: [], kinds: [], search: '' }),
      );
      expect(listed.total).toBe(1);
    });
  });

  describe('modification (UpdateCase) et pièces (AddCaseDocument)', () => {
    it('modifie un brouillon ; le mandat préparé non signé est à refaire', async () => {
      const created = await createDraft(world);
      const caseId = created.view.record.id;
      await asCreditor(() =>
        world.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: false }),
      );
      const updated = await asCreditor(() =>
        world.useCases.updateCase.execute({
          caseId,
          input: caseInput({ evidenceFileIds: [FILE_1, FILE_2], interests: 15_000 }),
          completionNote: '',
        }),
      );
      expect(updated.record).toMatchObject({
        status: 'draft',
        interests: 15_000,
        mandate: null,
        pricing: null,
      });
      expect(updated.record.documents.map((document) => document.fileId)).toEqual([FILE_1, FILE_2]);
      expect(world.files.subjects.get(FILE_2)).toEqual({ type: 'recovery_case', id: caseId });
    });

    it('refuse la modification d’un dossier envoyé, et d’un dossier d’un autre créancier (404)', async () => {
      const submitted = await submittedCase(world);
      const error = await rejection(
        asCreditor(() =>
          world.useCases.updateCase.execute({
            caseId: submitted.record.id,
            input: caseInput(),
            completionNote: '',
          }),
        ),
      );
      expect(error).toMatchObject({
        code: 'RECOVERY_INVALID_TRANSITION',
        details: { status: 'under_review' },
      });
      const foreign = await rejection(
        asOtherCreditor(() => world.useCases.getMyCase.execute({ caseId: submitted.record.id })),
      );
      expect(foreign.code).toBe('RECOVERY_CASE_NOT_FOUND');
    });

    it('ajoute un justificatif, une seule fois par fichier, et le note au journal', async () => {
      const created = await createDraft(world);
      const caseId = created.view.record.id;
      const added = await asCreditor(() =>
        world.useCases.addCaseDocument.execute({ caseId, fileId: FILE_2, label: 'Bon de livraison' }),
      );
      const again = await asCreditor(() =>
        world.useCases.addCaseDocument.execute({ caseId, fileId: FILE_2, label: 'Bon de livraison' }),
      );
      expect(again.id).toBe(added.id);
      const stored = await world.deps.cases.find(caseId);
      expect(stored!.documents.map((document) => document.label)).toEqual([
        'Justificatif 1',
        'Bon de livraison',
      ]);
      expect(world.deps.cases.evidence.map((entry) => entry.action)).toEqual([
        'case.created',
        'document.added',
      ]);
    });
  });

  describe('mandat et frais (PrepareMandate, PayCaseFee, UC-RC-03)', () => {
    it('fige la tarification, produit le mandat et demande la signature par code', async () => {
      const created = await createDraft(world);
      const prepared = await asCreditor(() =>
        world.useCases.prepareMandate.execute({
          caseId: created.view.record.id,
          duplicatesAcknowledged: false,
        }),
      );
      expect(prepared.view.record).toMatchObject({
        status: 'draft',
        fee: { amount: 25_000, studyFee: 5_000 },
        pricing: {
          commissionSummary: '10 % à l’amiable, 15 % après mise en demeure, 20 % au contentieux',
          feeRuleVersion: 1,
        },
        mandate: {
          documentId: prepared.documentId,
          signatureRequestId: prepared.signatureRequestId,
          signedAt: null,
        },
      });
      const [generated] = [...world.documents.generated.values()];
      expect(generated!.variables).toMatchObject({
        caseReference: 'RC-000001',
        creditor: { name: 'Awa Houngbo', kind: 'individual', address: 'Non communiquée' },
        debtor: { name: 'SARL Bénin Négoce', phoneE164: '+2290197000101' },
        claim: { principal: 750_000, dueDate: '2026-09-30', evidenceCount: 1 },
        fees: { successFeePercent: 10, fixedFee: 25_000 },
      });
      expect([...world.documents.signatures.values()]).toEqual([
        expect.objectContaining({ notice: 'code', userId: CREDITOR_ID, documentId: prepared.documentId }),
      ]);
      const again = await asCreditor(() =>
        world.useCases.prepareMandate.execute({
          caseId: created.view.record.id,
          duplicatesAcknowledged: false,
        }),
      );
      expect(again.signatureRequestId).toBe(prepared.signatureRequestId);
      expect(world.documents.generated.size).toBe(1);
    });

    it('exige une pièce, des dossiers semblables confirmés et une règle publiée', async () => {
      const first = await createDraft(world);
      const second = await createDraft(world, 'case-key-0002', { evidenceFileIds: [FILE_2] });
      const error = await rejection(
        asCreditor(() =>
          world.useCases.prepareMandate.execute({
            caseId: second.view.record.id,
            duplicatesAcknowledged: false,
          }),
        ),
      );
      expect(error).toMatchObject({
        code: 'RECOVERY_VALIDATION_FAILED',
        details: { field: 'duplicatesAcknowledged', duplicates: [first.view.record.number] },
      });
      const empty = caseWorld();
      empty.deps.rules.rules.clear();
      const draft = await createDraft(empty);
      const noRule = await rejection(
        asCreditor(() =>
          empty.useCases.prepareMandate.execute({
            caseId: draft.view.record.id,
            duplicatesAcknowledged: true,
          }),
        ),
      );
      expect(noRule.code).toBe('RECOVERY_PRICING_RULE_INVALID');
    });

    it('signature du mandat : « frais à payer », mandat joint, journal ; événement rejoué sans effet', async () => {
      const created = await createDraft(world);
      const caseId = created.view.record.id;
      const prepared = await asCreditor(() =>
        world.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: false }),
      );
      const event = {
        eventId: '0192f1c4-0000-7000-8000-0000000e0001',
        documentId: prepared.documentId,
        template: 'recovery_mandate',
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: caseId,
        signerUserId: CREDITOR_ID,
        signedAt: NOW.toISOString(),
      };
      expect(await world.useCases.recordMandateSignature.execute(event)).toBe('recorded');
      expect(await world.useCases.recordMandateSignature.execute(event)).toBe('ignored');
      expect(
        await world.useCases.recordMandateSignature.execute({
          ...event,
          template: 'recovery_settlement_agreement',
        }),
      ).toBe('ignored');
      const stored = await world.deps.cases.find(caseId);
      expect(stored).toMatchObject({ status: 'awaiting_fee', mandate: { signedAt: NOW } });
      expect(stored!.documents.at(-1)).toMatchObject({ kind: 'mandate', documentId: prepared.documentId });
      expect(world.deps.cases.inbox.size).toBe(1);
    });

    it('mandat non signé : RECOVERY_MANDATE_NOT_SIGNED', async () => {
      const created = await createDraft(world);
      const error = await rejection(
        asCreditor(() =>
          world.useCases.payCaseFee.execute({
            caseId: created.view.record.id,
            idempotencyKey: 'pay-key-0001',
          }),
        ),
      );
      expect(error.code).toBe('RECOVERY_MANDATE_NOT_SIGNED');
    });

    it('solde insuffisant : montant manquant, puis paiement après recharge, un seul débit', async () => {
      const created = await createDraft(world);
      const caseId = created.view.record.id;
      await signMandate(world, caseId);
      world.wallet.balances.set(CREDITOR_ID, 10_000);
      const pay = () =>
        asCreditor(() => world.useCases.payCaseFee.execute({ caseId, idempotencyKey: 'pay-key-0001' }));
      const error = await rejection(pay());
      expect(error).toMatchObject({
        code: 'RECOVERY_INSUFFICIENT_FUNDS',
        details: { missing: { amount: 15_000, currency: 'XOF' } },
      });
      expect((await world.deps.cases.find(caseId))!.fee.debitAttemptedAt).toBeNull();
      world.wallet.balances.set(CREDITOR_ID, 40_000);
      const paid = await pay();
      const replay = await pay();
      expect(paid.record).toMatchObject({ status: 'under_review', submittedAt: NOW, fee: { paidAt: NOW } });
      expect(paid.record.score).toMatchObject({ value: expect.any(Number) });
      expect(replay.record.version).toBe(paid.record.version);
      expect(world.wallet.balances.get(CREDITOR_ID)).toBe(15_000);
      expect([...world.wallet.debits.entries()]).toEqual([
        [
          caseFeeKey(caseId),
          expect.objectContaining({
            amount: 25_000,
            objectType: 'recovery_case_fee',
            objectId: caseId,
            description: 'Frais de dossier RC-000001',
          }),
        ],
      ]);
      expect(world.deps.cases.events).toEqual([
        {
          type: 'recovery.case.submitted',
          payload: {
            caseId,
            caseNumber: 'RC-000001',
            creditor: { type: 'user', id: CREDITOR_ID },
            kind: 'b2b',
            amountDue: { amount: 750_000, currency: 'XOF' },
            source: 'form',
            submittedAt: NOW.toISOString(),
          },
        },
      ]);
      expect(world.deps.cases.evidence.map((entry) => entry.action)).toEqual([
        'case.created',
        'mandate.prepared',
        'mandate.signed',
        'fee.paid',
        'case.submitted',
      ]);
    });

    it('wallet injoignable : la demande de débit reste marquée pour le rapprochement', async () => {
      const created = await createDraft(world);
      const caseId = created.view.record.id;
      await signMandate(world, caseId);
      world.wallet.balances.set(CREDITOR_ID, 100_000);
      world.wallet.unavailable = 1;
      const error = await rejection(
        asCreditor(() => world.useCases.payCaseFee.execute({ caseId, idempotencyKey: 'pay-key-0001' })),
      );
      expect(error.code).toBe('RECOVERY_DEPENDENCY_UNAVAILABLE');
      expect((await world.deps.cases.find(caseId))!.fee.debitAttemptedAt).toEqual(NOW);
    });
  });

  describe('suivi (ListMyCases, GetMyCase, ListMyCaseJournal, GetMyDashboard)', () => {
    it('liste les dossiers du contexte actif, filtre par statut, numéro ou nom du débiteur', async () => {
      await submittedCase(world);
      await createDraft(world, 'case-key-0002', {
        debtors: [
          {
            ...caseInput().debtors[0]!,
            kind: 'person',
            lastName: 'Dossou',
            firstNames: 'Koffi',
            legalName: '',
            phones: ['+2290196000001'],
          },
        ],
        evidenceFileIds: [FILE_2],
      });
      const list = (search: string, statuses: string[] = []) =>
        asCreditor(() => world.useCases.listMyCases.execute({ statuses, stages: [], kinds: [], search }));
      expect((await list('')).items.map((item) => item.summary.number)).toEqual(['RC-000002', 'RC-000001']);
      expect((await list('', ['draft'])).items.map((item) => item.summary.debtorName)).toEqual([
        'Koffi Dossou',
      ]);
      expect((await list('RC-000001')).total).toBe(1);
      expect((await list('dossou')).items.map((item) => item.summary.number)).toEqual(['RC-000002']);
      expect((await rejection(list('ab'))).code).toBe('RECOVERY_VALIDATION_FAILED');
      const others = await asOtherCreditor(() =>
        world.useCases.listMyCases.execute({ statuses: [], stages: [], kinds: [], search: '' }),
      );
      expect(others.total).toBe(0);
    });

    it('journal sans les notes internes ; tableau de bord du créancier', async () => {
      const submitted = await submittedCase(world);
      const caseId = submitted.record.id;
      world.deps.cases.evidence.push({ ...world.deps.cases.evidence[0]!, id: 'zz-internal', internal: true });
      const journal = await asCreditor(() => world.useCases.listMyCaseJournal.execute({ caseId }));
      expect(journal.entries.map((item) => item.entry.action)).not.toContain('case.created-internal');
      expect(journal.entries.every((item) => !item.entry.internal)).toBe(true);
      world.deps.caseQueries.collected.set(caseId, [{ amount: 150_000, stageGroup: 'amicable' }]);
      const dashboard = await asCreditor(() => world.useCases.getMyDashboard.execute());
      expect(dashboard).toMatchObject({
        entrusted: 750_000,
        recovered: 150_000,
        outstanding: 750_000,
        recoveryRateBps: 2_000,
      });
    });
  });

  describe('préférences (GetMyPreferences, UpdateMyPreferences)', () => {
    it('barèmes de KSP par défaut, puis ceux du créancier ; bornes contrôlées', async () => {
      const defaults = await asCreditor(() => world.useCases.getMyPreferences.execute());
      expect(defaults).toMatchObject({
        b2bScale: { maxDurationMonths: 12 },
        notifyUserIds: [],
        updatedAt: null,
      });
      const scale = { ...defaults.b2cScale!, maxDurationMonths: 3 };
      const saved = await asCreditor(() =>
        world.useCases.updateMyPreferences.execute({
          b2bScale: scale,
          b2cScale: scale,
          notifyUserIds: [CREDITOR_ID, CREDITOR_ID],
        }),
      );
      expect(saved).toMatchObject({ notifyUserIds: [CREDITOR_ID], updatedBy: CREDITOR_ID });
      expect((await asCreditor(() => world.useCases.getMyPreferences.execute())).b2bScale).toEqual(scale);
      const error = await rejection(
        asCreditor(() =>
          world.useCases.updateMyPreferences.execute({
            b2bScale: { ...scale, maxDurationMonths: 40 },
            b2cScale: scale,
            notifyUserIds: [],
          }),
        ),
      );
      expect(error).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'b2bScale' } });
    });
  });
});
