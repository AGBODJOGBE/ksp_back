/**
 * Réclamations (partie 12, R-RC-01 à R-RC-04 ; UC-NT-17, UC-NT-40). Domaine pur : l'heure, la
 * fenêtre de réclamation et l'état relu sont fournis par l'appelant.
 */
export const CLAIM_CATEGORIES = ['incomplete_work', 'damage', 'behavior', 'missing_item', 'other'] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];
export type ClaimStatus = 'open' | 'in_progress' | 'resolved' | 'rejected';
export type ClaimOutcome = 'free_redo' | 'wallet_credit' | 'rejected';
export const CLAIM_OUTCOMES: readonly ClaimOutcome[] = ['free_redo', 'wallet_credit', 'rejected'];

/** Crédit au-delà duquel une deuxième personne valide (R-RC-03), en FCFA. */
export const CREDIT_APPROVAL_THRESHOLD = 50_000;
/** Crédit maximal accepté par wallet (CreditRequest.amount). */
export const MAX_CREDIT = 1_000_000_000;
export const MAX_CLAIM_TEXT = 2000;
/** Photos d'une réclamation : même plafond que les photos par type d'une séance (défaut 10). */
export const MAX_CLAIM_PHOTOS = 10;

export type ClaimErrorCode =
  | 'CLEANING_VALIDATION_FAILED'
  | 'CLEANING_INVALID_TRANSITION'
  | 'CLEANING_CLAIM_WINDOW_CLOSED'
  | 'CLEANING_SECOND_APPROVER_REQUIRED';

export interface ClaimError {
  code: ClaimErrorCode;
  details: Record<string, unknown>;
}

export type ClaimDecisionResult<T> = { ok: true; value: T } | { ok: false; error: ClaimError };

const ok = <T>(value: T): ClaimDecisionResult<T> => ({ ok: true, value });
const fail = <T>(code: ClaimErrorCode, details: Record<string, unknown> = {}): ClaimDecisionResult<T> => ({
  ok: false,
  error: { code, details },
});
const invalid = <T>(field: string, reason: string) =>
  fail<T>('CLEANING_VALIDATION_FAILED', { field, reason });

/** Ce que les règles lisent d'une réclamation. */
export interface ClaimState {
  status: ClaimStatus;
  decision: ClaimOutcome | null;
  creditAmount: number | null;
  decidedBy: string | null;
  creditApprovedBy: string | null;
  firstResponseAt: Date | null;
}

const isOpen = (status: ClaimStatus) => status === 'open' || status === 'in_progress';

function message(text: string | null | undefined, field: string): ClaimDecisionResult<string> {
  const value = (text ?? '').trim();
  if (!value) return invalid(field, 'required');
  if (value.length > MAX_CLAIM_TEXT) return invalid(field, 'out_of_range');
  return ok(value);
}

export interface NewClaimInput {
  category: string;
  text: string;
  photoFileIds: readonly string[];
}

/**
 * R-RC-01 : séance réalisée, réclamation pendant la fenêtre réglée (48 h par défaut) après la fin
 * réelle, bornes comprises. Motif de la liste, texte obligatoire, photos plafonnées.
 */
export function openClaim(
  session: { status: string; completedAt: Date | null },
  input: NewClaimInput,
  now: Date,
  windowHours: number,
): ClaimDecisionResult<{ category: ClaimCategory; text: string; photoFileIds: readonly string[] }> {
  if (!(CLAIM_CATEGORIES as readonly string[]).includes(input.category))
    return invalid('category', 'invalid_type');
  const text = message(input.text, 'text');
  if (!text.ok) return text;
  if (input.photoFileIds.length > MAX_CLAIM_PHOTOS) return invalid('photoFileIds', 'out_of_range');
  if (session.status !== 'completed' || !session.completedAt) {
    return fail('CLEANING_INVALID_TRANSITION', { from: session.status, to: 'claimed' });
  }
  if (now.getTime() - session.completedAt.getTime() > windowHours * 3_600_000) {
    return fail('CLEANING_CLAIM_WINDOW_CLOSED', { windowHours });
  }
  return ok({
    category: input.category as ClaimCategory,
    text: text.value,
    photoFileIds: input.photoFileIds,
  });
}

/** R-RC-02 : le client répond sur une réclamation ouverte ou en cours. */
export function customerMessage(claim: ClaimState, text: string): ClaimDecisionResult<string> {
  const value = message(text, 'text');
  if (!value.ok) return value;
  if (!isOpen(claim.status))
    return fail('CLEANING_INVALID_TRANSITION', { from: claim.status, to: 'message' });
  return value;
}

/**
 * R-RC-02 : prise en charge (« en cours ») et/ou message au client. La première action du personnel
 * date la première réponse (objectif 24 h).
 */
export function staffUpdate(
  claim: ClaimState,
  input: { status: string | null; message: string | null },
  now: Date,
): ClaimDecisionResult<{ status: ClaimStatus; message: string | null; firstResponseAt: Date }> {
  if (input.status !== null && input.status !== 'in_progress') return invalid('status', 'invalid_type');
  if (input.status === null && input.message === null) return invalid('message', 'required');
  let text: string | null = null;
  if (input.message !== null) {
    const value = message(input.message, 'message');
    if (!value.ok) return value;
    text = value.value;
  }
  if (!isOpen(claim.status))
    return fail('CLEANING_INVALID_TRANSITION', { from: claim.status, to: 'in_progress' });
  return ok({
    status: input.status === 'in_progress' ? 'in_progress' : claim.status,
    message: text,
    firstResponseAt: claim.firstResponseAt ?? now,
  });
}

export interface DecisionInput {
  outcome: ClaimOutcome;
  creditAmount: number | null;
  reason: string;
}

/**
 * R-RC-03 : repasse gratuite, crédit ou rejet motivé, sur une réclamation ouverte ou en cours et
 * pas encore décidée. Un crédit de plus de CREDIT_APPROVAL_THRESHOLD reste « en cours » jusqu'à la
 * validation d'une deuxième personne.
 */
export function decideClaim(
  claim: ClaimState,
  input: DecisionInput,
  _deciderId: string,
): ClaimDecisionResult<DecisionInput & { status: ClaimStatus; pendingApproval: boolean }> {
  if (!CLAIM_OUTCOMES.includes(input.outcome)) return invalid('outcome', 'invalid_type');
  const reason = message(input.reason, 'reason');
  if (!reason.ok) return reason;
  const credit = input.outcome === 'wallet_credit';
  if (credit && input.creditAmount === null) return invalid('creditAmount', 'required');
  if (!credit && input.creditAmount !== null) return invalid('creditAmount', 'not_applicable');
  if (
    credit &&
    (!Number.isInteger(input.creditAmount) || input.creditAmount! < 1 || input.creditAmount! > MAX_CREDIT)
  ) {
    return invalid('creditAmount', 'out_of_range');
  }
  if (!isOpen(claim.status) || claim.decision !== null) {
    return fail('CLEANING_INVALID_TRANSITION', {
      from: claim.decision ? 'decided' : claim.status,
      to: 'decided',
    });
  }
  const pendingApproval = credit && input.creditAmount! > CREDIT_APPROVAL_THRESHOLD;
  const status: ClaimStatus =
    input.outcome === 'rejected' ? 'rejected' : pendingApproval ? 'in_progress' : 'resolved';
  return ok({ ...input, reason: reason.value, status, pendingApproval });
}

/** Validation d'un crédit : not_required, pending (en attente d'une deuxième personne), approved. */
export function approvalStatus(claim: ClaimState): 'not_required' | 'pending' | 'approved' {
  if (claim.decision !== 'wallet_credit' || (claim.creditAmount ?? 0) <= CREDIT_APPROVAL_THRESHOLD) {
    return 'not_required';
  }
  return claim.creditApprovedBy ? 'approved' : 'pending';
}

/** R-RC-03, R-WL-04 : une deuxième personne, autre que l'auteur de la décision, valide le crédit. */
export function approveCredit(
  claim: ClaimState,
  approverId: string,
): ClaimDecisionResult<{ status: 'resolved' }> {
  if (approvalStatus(claim) !== 'pending' || !isOpen(claim.status)) {
    return fail('CLEANING_INVALID_TRANSITION', { from: claim.status, to: 'credit_approved' });
  }
  if (approverId === claim.decidedBy) return fail('CLEANING_SECOND_APPROVER_REQUIRED');
  return ok({ status: 'resolved' });
}

const DAY_MS = 86_400_000;

/**
 * Créneau de la repasse gratuite (séance à 0 FCFA ajoutée au programme). Le contrat ne donne pas de
 * date : interprétation prudente, même heure et même durée que la séance réclamée, le premier jour
 * qui commence au moins `leadHours` après la décision (délai minimum avant une séance, 48 h) et ne
 * chevauche aucune séance du programme. Le superviseur peut ensuite la reporter.
 */
export function redoSlot(
  claimed: { start: Date; end: Date },
  now: Date,
  leadHours: number,
  programSessions: readonly { start: Date; end: Date }[],
): { start: Date; end: Date } {
  const duration = claimed.end.getTime() - claimed.start.getTime();
  const earliest = now.getTime() + leadHours * 3_600_000;
  let start = claimed.start.getTime();
  while (start < earliest) start += DAY_MS;
  const overlaps = (s: number) =>
    programSessions.some((other) => other.start.getTime() < s + duration && s < other.end.getTime());
  while (overlaps(start)) start += DAY_MS;
  return { start: new Date(start), end: new Date(start + duration) };
}
