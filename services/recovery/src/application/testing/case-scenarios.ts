import { runWithContext } from '@ksp/platform';
import { type CaseInputData } from '../cases/case-input';
import { type StoredPricingRule } from '../ports';
import { createUseCases } from '../use-cases';
import { MemoryDirectory, MemoryDocuments, MemoryFiles, MemoryWallet } from './case-fakes';
import { asCreditor, CREDITOR_ID, makeDeps, NOW } from './fakes';

/** Monde de test des dossiers : dépôts en mémoire, portefeuille, documents, fichiers, annuaire. */

export const FILE_1 = '0192f1c4-0000-7000-8000-0000000f0001';
export const FILE_2 = '0192f1c4-0000-7000-8000-0000000f0002';
export const FILE_3 = '0192f1c4-0000-7000-8000-0000000f0003';
export const SUPERVISOR_ID = '0192f1c4-0000-7000-8000-00000000500e';
export const LEGAL_ID = '0192f1c4-0000-7000-8000-000000001e9a';
export const OTHER_AGENT_ID = '0192f1c4-0000-7000-8000-00000000a6e2';
export const OTHER_CREDITOR_ID = '0192f1c4-0000-7000-8000-00000000c002';

const rule = (
  id: string,
  object: StoredPricingRule['rule']['object'],
  mode: StoredPricingRule['rule']['mode'],
) => ({
  rule: {
    id,
    object,
    mode,
    bounds: { minimum: null, maximum: null },
    target: { offer: 'any' as const, communeKey: null, creditorId: null },
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validUntil: null,
    status: 'published' as const,
    version: 1,
    createdBy: '0192f1c4-0000-7000-8000-00000000ad01',
    approvedBy: null,
    previousVersionId: null,
  },
  label: object,
  creditorType: null,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  archivedAt: null,
  archiveReason: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

export const FEE_RULE_ID = '0192f1c4-0000-7000-8000-0000000fee01';
export const COMMISSION_RULE_ID = '0192f1c4-0000-7000-8000-0000000c0301';
export const STUDY_RULE_ID = '0192f1c4-0000-7000-8000-0000000575d1';

/**
 * Grille publiée : frais par tranche du dû (10 000 jusqu'à 500 000, 25 000 jusqu'à 2 000 000, 50 000
 * au-delà), commission par étape (10, 15, 20 %), forfait d'étude de 5 000 FCFA.
 */
export function caseWorld(options: { studyFee?: boolean } = {}) {
  const wallet = new MemoryWallet();
  const documents = new MemoryDocuments();
  const files = new MemoryFiles();
  const directory = new MemoryDirectory();
  const deps = makeDeps({ wallet, documents, files, directory });
  const rules: StoredPricingRule[] = [
    rule(FEE_RULE_ID, 'case_fee', {
      kind: 'tiered',
      tiers: [
        { upTo: 500_000, rateBps: null, fixedAmount: 10_000 },
        { upTo: 2_000_000, rateBps: null, fixedAmount: 25_000 },
        { upTo: null, rateBps: null, fixedAmount: 50_000 },
      ],
    }),
    rule(COMMISSION_RULE_ID, 'recovery_commission', {
      kind: 'by_stage',
      stageRates: { amicable: 1_000, formal_notice: 1_500, litigation: 2_000 },
    }),
  ];
  if (options.studyFee !== false)
    rules.push(rule(STUDY_RULE_ID, 'study_fee', { kind: 'fixed', fixedAmount: 5_000 }));
  for (const stored of rules) deps.rules.rules.set(stored.rule.id, stored);
  return { deps, useCases: createUseCases(deps), wallet, documents, files, directory };
}

export type CaseWorld = ReturnType<typeof caseWorld>;

/** Saisie d'un dossier B2B : une société débitrice, deux factures (750 000 FCFA), une pièce. */
export function caseInput(change: Partial<CaseInputData> = {}): CaseInputData {
  return {
    kind: 'b2b',
    nature: 'unpaid_invoice',
    debtors: [
      {
        kind: 'company',
        role: 'main',
        firstNames: '',
        lastName: '',
        legalName: 'SARL Bénin Négoce',
        ifu: '3201900000001',
        rccm: '',
        representativeName: '',
        phones: ['+22997000101'],
        emails: ['Compta@Negoce.bj'],
        address: 'Akpakpa, Cotonou',
        communeKey: 'cotonou',
      },
    ],
    claims: [
      { reference: 'F-2026-001', amount: 300_000, dueDate: '2026-09-30', description: 'Livraison de ciment' },
      { reference: 'F-2026-002', amount: 450_000, dueDate: '2026-10-15', description: '' },
    ],
    interests: null,
    alreadyPaid: null,
    priorEffort: {
      remindersCount: 2,
      lastReminderDate: '2026-11-01',
      channels: ['phone', 'email'],
      debtAcknowledged: false,
      acknowledgmentFileId: '',
      promisesReceived: '',
      preserveRelationship: true,
    },
    planScale: null,
    evidenceFileIds: [FILE_1],
    ...change,
  };
}

export const createDraft = (world: CaseWorld, key = 'case-key-0001', change: Partial<CaseInputData> = {}) =>
  asCreditor(() => world.useCases.createCase.execute({ idempotencyKey: key, input: caseInput(change) }));

let eventCounter = 0;

/** Mandat préparé puis signé (événement de document). */
export async function signMandate(world: CaseWorld, caseId: string) {
  const prepared = await asCreditor(() =>
    world.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: true }),
  );
  eventCounter += 1;
  await world.useCases.recordMandateSignature.execute({
    eventId: `0192f1c4-0000-7000-8000-${eventCounter.toString(16).padStart(12, '0')}`,
    documentId: prepared.documentId,
    template: 'recovery_mandate',
    producerService: 'recovery',
    subjectType: 'recovery_case',
    subjectId: caseId,
    signerUserId: CREDITOR_ID,
    signedAt: NOW.toISOString(),
  });
  return prepared;
}

/** Dossier envoyé en examen : brouillon, mandat signé, frais payés (portefeuille approvisionné). */
export async function submittedCase(
  world: CaseWorld,
  key = 'case-key-0001',
  change: Partial<CaseInputData> = {},
) {
  const created = await createDraft(world, key, change);
  await signMandate(world, created.view.record.id);
  world.wallet.balances.set(CREDITOR_ID, (world.wallet.balances.get(CREDITOR_ID) ?? 0) + 100_000);
  return asCreditor(() =>
    world.useCases.payCaseFee.execute({ caseId: created.view.record.id, idempotencyKey: `pay-${key}` }),
  );
}

/** Membre lecteur (org_viewer) de l'organisation active. */
export function asOrgViewer<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      correlationId: 'c-test',
      callerService: 'gateway',
      user: {
        userId: CREDITOR_ID,
        sessionId: 's-test',
        activeContext: organizationId,
        roles: [{ role: 'org_viewer', scopeType: 'org', scopeId: organizationId }],
        mfa: false,
      },
    },
    fn,
  );
}

/** Autre créancier connecté (son compte personnel). */
export function asOtherCreditor<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      correlationId: 'c-test',
      callerService: 'gateway',
      user: {
        userId: OTHER_CREDITOR_ID,
        sessionId: 's-test',
        activeContext: 'personal',
        roles: [],
        mfa: false,
      },
    },
    fn,
  );
}
