import { type CaseInputData } from '../cases/case-input';
import { type RecoveryCaseRecord } from '../cases/ports';
import {
  CaseBackedDebtorReader,
  type MemoryAmicableStore,
  type MemoryDocumentCancellation,
} from './amicable-fakes';
import { caseWorld, submittedCase, SUPERVISOR_ID } from './case-scenarios';
import { CapturingNotifier } from './debtor-access.fakes';
import { AGENT_ID, asStaff, CREDITOR_ID, NOW } from './fakes';

/** Monde de test de la procédure amiable : celui des dossiers, plus notification et liens du débiteur. */

export const LEGAL_OFFICER_ID = '0192f1c4-0000-7000-8000-000000001e9b';

export function amicableWorld(options: { studyFee?: boolean } = {}) {
  const world = caseWorld(options);
  const notifier = new CapturingNotifier();
  world.deps.notifier = notifier;
  world.deps.debtorAccess.reader = new CaseBackedDebtorReader(world.deps.cases, world.deps.personalData);
  world.directory.users.set(CREDITOR_ID, 'Awa Dossou');
  return {
    ...world,
    notifier,
    store: world.deps.amicable as MemoryAmicableStore,
    cancellations: world.deps.documentCancellation as MemoryDocumentCancellation,
  };
}

export type AmicableWorld = ReturnType<typeof amicableWorld>;

/** Avance l'horloge du monde à cet instant (ISO, UTC). */
export function at(world: AmicableWorld, instant: string): Date {
  world.deps.clock.current = new Date(instant);
  return world.deps.clock.current;
}

/** Membre du personnel, double authentification d'il y a une minute à l'heure du monde. */
export function asStaffNow<T>(
  world: AmicableWorld,
  userId: string,
  roles: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const elapsed = Math.round((world.deps.clock.current.getTime() - NOW.getTime()) / 1000);
  return asStaff(userId, roles, fn, 60 - elapsed);
}

export const asAgent = <T>(world: AmicableWorld, fn: () => Promise<T>) =>
  asStaffNow(world, AGENT_ID, ['recovery_agent'], fn);
export const asSupervisor = <T>(world: AmicableWorld, fn: () => Promise<T>) =>
  asStaffNow(world, SUPERVISOR_ID, ['recovery_supervisor'], fn);
export const asLegal = <T>(world: AmicableWorld, fn: () => Promise<T>) =>
  asStaffNow(world, LEGAL_OFFICER_ID, ['legal_officer'], fn);

/**
 * Dossier accepté par le superviseur (actif, étape de notification) et affecté au chargé : dossier B2B
 * de 750 000 FCFA, débiteur avec téléphone et e-mail, sauf changement de la saisie.
 */
export async function activeCase(
  world: AmicableWorld,
  key = 'case-key-0001',
  change: Partial<CaseInputData> = {},
): Promise<RecoveryCaseRecord> {
  const submitted = await submittedCase(world, key, change);
  const caseId = submitted.record.id;
  await asSupervisor(world, () =>
    world.useCases.assessCase.execute({
      caseId,
      idempotencyKey: `assess-${key}`,
      decision: 'accept',
      note: '',
      agentUserId: AGENT_ID,
      rejectionReason: '',
    }),
  );
  return world.deps.cases.cases.get(caseId)!;
}

/** État courant d'un dossier du dépôt en mémoire. */
export const caseOf = (world: AmicableWorld, caseId: string) => world.deps.cases.cases.get(caseId)!;

/** Encaissement reçu (table du lot R3), lu par la procédure amiable. */
export function collect(world: AmicableWorld, caseId: string, gross: number, instant?: string): void {
  world.store.collections.push({
    caseId,
    gross,
    overpaid: 0,
    collectedAt: instant ? new Date(instant) : world.deps.clock.current,
  });
}

/** Événements publiés d'un type. */
export const eventsOf = (world: AmicableWorld, type: string) =>
  world.deps.cases.events.filter((event) => event.type === type);
