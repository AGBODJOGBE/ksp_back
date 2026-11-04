import { withoutPosition } from '../../domain/location';
import { isTerminalMission } from '../../domain/mission';
import { type QuoteRequest } from '../../domain/quote-request';
import { type CleaningDeps, type MissionView } from '../deps';
import {
  type GroupOperation,
  type GroupOperationRecord,
  type GroupOutcome,
  type QuoteRequestGroupView,
} from '../ports';
import { seesEverything, type Staff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { requireUuid } from '../shared/validation';

/**
 * Outils communs aux opérations de groupe (ADR-035) : lecture du groupe, idempotence par
 * (auteur, opération, clé), masquage de la position pour les rôles de terrain.
 */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** Clé facultative (back-office) ou obligatoire (client) ; vide : aucun contrôle de rejeu. */
export function parseKey(value: string | undefined, required: boolean): string {
  const key = (value ?? '').trim();
  if (!key) {
    if (required) throw CleaningErrors.invalid('idempotencyKey', 'Clé d’idempotence obligatoire.');
    return '';
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw CleaningErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
  }
  return key;
}

/** Groupe quelconque (back-office), sinon introuvable. */
export async function anyGroup(deps: CleaningDeps, groupId: string): Promise<QuoteRequestGroupView> {
  const view = await deps.requests.findGroup(requireUuid('groupId', groupId));
  if (!view) throw CleaningErrors.requestGroupNotFound();
  return view;
}

/** Groupe du client, sinon introuvable : jamais révéler le groupe d'un autre (404). */
export async function ownGroup(
  deps: CleaningDeps,
  customerId: string,
  groupId: string,
): Promise<QuoteRequestGroupView> {
  const view = await deps.requests.findGroup(requireUuid('groupId', groupId));
  if (!view || view.group.customerId !== customerId) throw CleaningErrors.requestGroupNotFound();
  return view;
}

export function emptyOutcome(groupId: string): GroupOutcome {
  return {
    groupId,
    affectedIds: [],
    skippedRequests: [],
    skippedMissions: [],
    groupVisitId: null,
    missionIds: [],
  };
}

/**
 * Opération déjà faite avec cette clé : son résultat, rejoué tel quel ; une clé utilisée pour un
 * autre groupe est refusée (CLEANING_IDEMPOTENCY_KEY_REUSED).
 */
export async function previousOutcome(
  deps: CleaningDeps,
  actorId: string,
  operation: GroupOperation,
  key: string,
  groupId: string,
): Promise<GroupOutcome | null> {
  if (!key) return null;
  const previous = await deps.requests.findGroupOperation(actorId, operation, key);
  if (!previous) return null;
  if (previous.outcome.groupId !== groupId) throw CleaningErrors.idempotencyKeyReused();
  return previous.outcome;
}

export function operationRecord(
  actorId: string,
  operation: GroupOperation,
  key: string,
  outcome: GroupOutcome,
): GroupOperationRecord | null {
  return key ? { actorId, operation, idempotencyKey: key, outcome } : null;
}

/**
 * Issue d'une écriture de groupe : un appel concurrent avec la même clé l'a déjà faite (on rejoue
 * son résultat), ou une demande a changé entre-temps (à recharger).
 */
export async function settle(
  deps: CleaningDeps,
  written: 'saved' | 'conflict' | 'replayed' | 'organization_suspended',
  replay: { actorId: string; operation: GroupOperation; key: string; groupId: string },
  outcome: GroupOutcome,
): Promise<GroupOutcome> {
  if (written === 'saved') return outcome;
  if (written === 'organization_suspended') throw CleaningErrors.organizationSuspended();
  if (written === 'replayed') {
    const previous = await previousOutcome(
      deps,
      replay.actorId,
      replay.operation,
      replay.key,
      replay.groupId,
    );
    if (previous) return previous;
  }
  throw CleaningErrors.concurrentUpdate();
}

/**
 * Position masquée pour un agent (ADR-035) : un agent seul ne voit plus la position, le repère ni
 * l'adresse géocodée d'une visite terminée ou annulée ; la supervision garde l'accès.
 */
export function requestForStaff(staff: Staff, request: QuoteRequest): QuoteRequest {
  if (seesEverything(staff) || request.visit?.status === 'scheduled') return request;
  return { ...withoutPosition(request), geocodedAddress: null };
}

/** Même règle pour une mission : terminée ou annulée, sa position est masquée pour un agent seul. */
export function missionForStaff(staff: Staff, view: MissionView): MissionView {
  if (seesEverything(staff) || !isTerminalMission(view.mission.status)) return view;
  return { ...view, mission: withoutPosition(view.mission) };
}
