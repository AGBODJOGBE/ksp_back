import {
  attemptsLeft,
  checkAttemptAllowed,
  checkLink,
  codeExpiry,
  codeResendWait,
  DEFAULT_CLOSED_ACCESS_DAYS,
  type DebtorAccessMode,
  debtorAccessMode,
  isCodeValid,
  isLocked,
  registerFailure,
  registerSuccess,
  retryAfterSeconds,
  sessionExpiry,
} from '../../domain/debtor-access';
import { FIXED_RULES } from '../../domain/settings';
import {
  type Clock,
  type Directory,
  type IdGenerator,
  type Notifier,
  type PersonalData,
  type SettingsStore,
} from '../ports';
import { loadSettings } from '../settings.use-cases';
import { GATEWAY_CALLERS, requireCaller } from '../shared/access';
import { RecoveryErrors } from '../shared/errors';
import { DebtorAccessErrors } from './debtor-access.errors';
import {
  type CaseDebtor,
  type DebtorAccessAction,
  type DebtorAccessPorts,
  type StoredDebtorAccess,
} from './debtor-access.ports';
import { type CodeRecipient, codeRecipient } from './debtor-contact';

/**
 * Accès du débiteur sans compte (partie 7, 17.3 ; ADR-061) : aperçu du lien, code envoyé à chaque
 * ouverture, session courte, fin de session. Méthodes réservées à la gateway (routes publiques) ;
 * ni jeton, ni code, ni coordonnée ne sortent dans un journal, une erreur ou un événement.
 */
export interface DebtorAccessDeps {
  debtorAccess: DebtorAccessPorts;
  settings: SettingsStore;
  personalData: PersonalData;
  notifier: Notifier;
  directory: Directory;
  clock: Clock;
  ids: IdGenerator;
}

/** Jeton du lien ou de la session : 32 octets en base64url (43 caractères). */
const DEBTOR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[0-9]{6}$/;

const LOCK_OPTIONS = {
  maxAttempts: FIXED_RULES.debtorCodeMaxAttempts,
  lockMinutes: FIXED_RULES.debtorLockMinutes,
};

/**
 * Accès du débiteur à son dossier : complet s'il est actif ou suspendu, en lecture seule pendant les N
 * jours qui suivent sa clôture (`closedAccessDays`), aucun sinon.
 */
function accessMode(
  deps: Pick<DebtorAccessDeps, 'debtorAccess'>,
  caseDebtor: CaseDebtor,
  now: Date,
): DebtorAccessMode | null {
  return debtorAccessMode(
    caseDebtor.caseStatus,
    caseDebtor.closedAt ?? null,
    now,
    deps.debtorAccess.closedAccessDays ?? DEFAULT_CLOSED_ACCESS_DAYS,
  );
}

/**
 * Lien utilisable : jeton bien formé et connu, lien ni révoqué ni expiré, débiteur toujours dans un
 * dossier actif ou suspendu, ou clos depuis moins de N jours (lecture seule). Sinon
 * `RECOVERY_DEBTOR_LINK_INVALID`, la même erreur dans tous les cas.
 */
async function usableLink(
  deps: DebtorAccessDeps,
  token: string,
  now: Date,
): Promise<{ access: StoredDebtorAccess; caseDebtor: CaseDebtor }> {
  if (!DEBTOR_TOKEN.test(token)) throw DebtorAccessErrors.linkInvalid();
  const { store, reader, secrets } = deps.debtorAccess;
  const access = await store.findByTokenHash(secrets.hashToken(token));
  if (!access || !checkLink(access.link, now).ok) throw DebtorAccessErrors.linkInvalid();
  const caseDebtor = await reader.caseDebtor(access.caseId, access.debtorId);
  if (!caseDebtor || !accessMode(deps, caseDebtor, now)) throw DebtorAccessErrors.linkInvalid();
  return { access, caseDebtor };
}

/** Où partira le code. Sans téléphone ni e-mail valable, le lien ne peut pas s'ouvrir : lien invalide. */
async function recipientOf(deps: DebtorAccessDeps, debtorId: string): Promise<CodeRecipient> {
  const contacts = await deps.debtorAccess.reader.contacts(debtorId);
  const recipient = codeRecipient(contacts, deps.personalData);
  if (!recipient) throw DebtorAccessErrors.linkInvalid();
  return recipient;
}

/** Nom du créancier, seule donnée du créancier montrée au débiteur (R-DB-01) ; vide s'il est inconnu. */
async function creditorNameOf(directory: Directory, creditor: CaseDebtor['creditor']): Promise<string> {
  if (creditor.type === 'organization') {
    const [organization] = await directory.organizationsByIds([creditor.id]);
    return organization?.displayName ?? '';
  }
  const [user] = await directory.usersByIds([creditor.id]);
  return user?.displayName ?? '';
}

/** Ligne du journal de preuve : le débiteur agit sous son identifiant, le système sans identifiant. */
function journal(
  deps: DebtorAccessDeps,
  access: StoredDebtorAccess,
  event: {
    occurredAt: Date;
    actor: 'debtor' | 'system';
    action: DebtorAccessAction;
    channel?: 'whatsapp' | 'email';
    summary: string;
  },
): Promise<void> {
  return deps.debtorAccess.journal.record({
    caseId: access.caseId,
    accessId: access.id,
    occurredAt: event.occurredAt,
    actorType: event.actor,
    actorId: event.actor === 'debtor' ? access.debtorId : null,
    action: event.action,
    channel: event.channel ?? null,
    summary: event.summary,
  });
}

const CHANNEL_LABELS: Record<CodeRecipient['channel'], string> = { whatsapp: 'WhatsApp', email: 'e-mail' };

/**
 * Aperçu du lien (OpenDebtorAccess) : nom du créancier, coordonnée masquée où partira le code et fin
 * de validité du lien ; rien d'autre avant le code (R-DB-01). Chaque ouverture est écrite au journal.
 */
export class OpenDebtorAccessUseCase {
  constructor(private readonly deps: DebtorAccessDeps) {}

  async execute(input: { token: string }): Promise<{
    creditorName: string;
    contactMasked: string;
    linkExpiresAt: Date;
  }> {
    requireCaller(GATEWAY_CALLERS);
    const now = this.deps.clock.now();
    const { access, caseDebtor } = await usableLink(this.deps, input.token, now);
    const recipient = await recipientOf(this.deps, access.debtorId);
    const creditorName = await creditorNameOf(this.deps.directory, caseDebtor.creditor);
    await journal(this.deps, access, {
      occurredAt: now,
      actor: 'debtor',
      action: 'debtor_link_opened',
      summary: 'Lien personnel ouvert par le débiteur.',
    });
    return { creditorName, contactMasked: recipient.masked, linkExpiresAt: access.link.expiresAt };
  }
}

type CodeReservation = { refusal: Error } | { previousSentAt: Date | null; rank: number };

/**
 * Code d'accès (SendDebtorAccessCode) : 6 chiffres tirés par un générateur cryptographique, valables
 * 10 minutes, un par minute, refusés pendant un blocage. Il part au téléphone du débiteur par WhatsApp,
 * à l'e-mail du dossier s'il n'a pas de téléphone ; seule son empreinte HMAC est gardée et il remplace
 * le code précédent. L'envoi est réservé sous le verrou du lien avant l'appel à notification : deux
 * demandes simultanées n'envoient qu'un code. Si notification échoue, la réservation est rendue et
 * une nouvelle demande passe aussitôt.
 */
export class SendDebtorAccessCodeUseCase {
  constructor(private readonly deps: DebtorAccessDeps) {}

  async execute(input: { token: string }): Promise<{
    channel: CodeRecipient['channel'];
    codeExpiresAt: Date;
    retryAfterSeconds: number;
  }> {
    requireCaller(GATEWAY_CALLERS);
    const now = this.deps.clock.now();
    const { access } = await usableLink(this.deps, input.token, now);
    const recipient = await recipientOf(this.deps, access.debtorId);
    const { store, secrets } = this.deps.debtorAccess;
    const code = secrets.newCode();
    const issued = {
      hash: secrets.hashCode(access.id, code),
      expiresAt: codeExpiry(now, FIXED_RULES.debtorCodeMinutes),
    };

    const reservation = await store.updateLocked<CodeReservation>(access.id, (current) => {
      if (!checkLink(current.link, now).ok) {
        return { change: null, result: { refusal: DebtorAccessErrors.linkInvalid() } };
      }
      if (isLocked(current.attempts, now)) {
        const retryAfter = retryAfterSeconds(current.attempts, now);
        return { change: null, result: { refusal: DebtorAccessErrors.locked(retryAfter) } };
      }
      const wait = codeResendWait(current.codeSentAt, now, FIXED_RULES.debtorCodeResendSeconds);
      if (wait > 0) return { change: null, result: { refusal: DebtorAccessErrors.codeTooSoon(wait) } };
      return {
        change: { code: issued, codeSentAt: now, countCodeSent: true },
        result: { previousSentAt: current.codeSentAt, rank: current.codesSent + 1 },
      };
    });
    if (!reservation) throw DebtorAccessErrors.linkInvalid();
    if ('refusal' in reservation) throw reservation.refusal;

    try {
      await this.deps.notifier.sendToDebtor({
        message: 'access_code',
        channel: recipient.channel,
        phone: recipient.phone,
        email: recipient.email,
        variables: { code, expires_in_minutes: String(FIXED_RULES.debtorCodeMinutes) },
        idempotencyKey: `debtor-access:${access.id}:code:${reservation.rank}`,
      });
    } catch (error) {
      // Rien n'est parti (ou rien n'est sûr) : la limite d'un code par minute ne doit pas bloquer la
      // nouvelle demande. Le code reste enregistré : s'il est malgré tout arrivé, il reste valable.
      await store
        .updateLocked(access.id, (current) =>
          current.code?.hash === issued.hash
            ? { change: { codeSentAt: reservation.previousSentAt }, result: true }
            : { change: null, result: false },
        )
        .catch(() => undefined);
      throw error;
    }

    await journal(this.deps, access, {
      occurredAt: now,
      actor: 'system',
      action: 'debtor_code_sent',
      channel: recipient.channel,
      summary: `Code d’accès envoyé au débiteur par ${CHANNEL_LABELS[recipient.channel]}.`,
    });
    return {
      channel: recipient.channel,
      codeExpiresAt: issued.expiresAt,
      retryAfterSeconds: FIXED_RULES.debtorCodeResendSeconds,
    };
  }
}

type Verification =
  | { kind: 'link_invalid' | 'code_expired' | 'verified' }
  | { kind: 'locked' | 'locked_now'; retryAfter: number }
  | { kind: 'wrong'; attemptsLeft: number };

/**
 * Validation du code (VerifyDebtorAccessCode). L'essai est pris sous le verrou du lien, avant la
 * comparaison (ADR-050) : des essais simultanés ne comparent jamais plus de codes que le plafond.
 * Code juste : il est consommé et une session s'ouvre pour ce seul dossier et ce seul débiteur (jeton
 * rendu une seule fois, empreinte seule gardée, durée des réglages). Code faux :
 * `RECOVERY_DEBTOR_CODE_INVALID` (`attemptsLeft`) ; au cinquième, accès bloqué une heure
 * (`RECOVERY_DEBTOR_LOCKED`). Sans code valable : `RECOVERY_DEBTOR_CODE_EXPIRED`, sans essai compté.
 */
export class VerifyDebtorAccessCodeUseCase {
  constructor(private readonly deps: DebtorAccessDeps) {}

  async execute(input: { token: string; code: string }): Promise<{
    sessionToken: string;
    sessionExpiresAt: Date;
  }> {
    requireCaller(GATEWAY_CALLERS);
    const now = this.deps.clock.now();
    if (!DEBTOR_TOKEN.test(input.token)) throw DebtorAccessErrors.linkInvalid();
    if (!CODE.test(input.code)) throw RecoveryErrors.invalid('code', 'Code de 6 chiffres attendu.');
    const { access } = await usableLink(this.deps, input.token, now);
    const { settings } = await loadSettings(this.deps.settings);
    const { store, secrets } = this.deps.debtorAccess;
    const sessionToken = secrets.newToken();
    const session = {
      id: this.deps.ids.next(),
      tokenHash: secrets.hashToken(sessionToken),
      createdAt: now,
      expiresAt: sessionExpiry(now, settings.debtorSessionMinutes),
    };

    const verification = await store.updateLocked<Verification>(access.id, (current) => {
      if (!checkLink(current.link, now).ok) return { change: null, result: { kind: 'link_invalid' } };
      const allowed = checkAttemptAllowed(current.attempts, now);
      if (!allowed.ok) {
        return {
          change: null,
          result: { kind: 'locked', retryAfter: retryAfterSeconds(current.attempts, now) },
        };
      }
      const code = current.code;
      if (!code || !isCodeValid(code, now)) return { change: null, result: { kind: 'code_expired' } };
      if (secrets.codeMatches(current.id, input.code, code.hash)) {
        return { change: { attempts: registerSuccess(), code: null, session }, result: { kind: 'verified' } };
      }
      const attempts = registerFailure(allowed.value, now, LOCK_OPTIONS);
      return {
        change: { attempts },
        result: attempts.lockedUntil
          ? { kind: 'locked_now', retryAfter: retryAfterSeconds(attempts, now) }
          : { kind: 'wrong', attemptsLeft: attemptsLeft(attempts, LOCK_OPTIONS.maxAttempts) },
      };
    });

    switch (verification?.kind) {
      case 'verified':
        await journal(this.deps, access, {
          occurredAt: now,
          actor: 'debtor',
          action: 'debtor_code_verified',
          summary: 'Code d’accès validé : session du débiteur ouverte.',
        });
        return { sessionToken, sessionExpiresAt: session.expiresAt };
      case 'wrong':
        throw DebtorAccessErrors.codeInvalid(verification.attemptsLeft);
      case 'locked_now':
        await journal(this.deps, access, {
          occurredAt: now,
          actor: 'system',
          action: 'debtor_access_locked',
          summary: `${LOCK_OPTIONS.maxAttempts} codes faux : accès du débiteur bloqué pendant une heure.`,
        });
        throw DebtorAccessErrors.locked(verification.retryAfter);
      case 'locked':
        throw DebtorAccessErrors.locked(verification.retryAfter);
      case 'code_expired':
        throw DebtorAccessErrors.codeExpired();
      default:
        throw DebtorAccessErrors.linkInvalid();
    }
  }
}

/** Ce qu'une session donne : un seul dossier et un seul débiteur (ADR-061, R-DB-01). */
export interface DebtorSessionScope {
  caseId: string;
  debtorId: string;
  accessId: string;
  sessionId: string;
  expiresAt: Date;
  /** Dossier clos depuis moins de N jours : lecture de ses documents seulement. */
  readOnly: boolean;
}

/**
 * Usage de la session demandé par la méthode : `read` (situation, documents, fin de session) reste
 * permis en lecture seule après la clôture ; `write` (paiement, échéancier, contestation, pièce,
 * rappel) ne l'est que sur un dossier en cours.
 */
export type DebtorSessionUse = 'read' | 'write';

/**
 * Session du débiteur (en-tête X-Debtor-Session, transmis par la gateway en métadonnée
 * `x-debtor-session`), vérifiée à chaque appel : la gateway ne la vérifie pas. Absente, mal formée,
 * inconnue, expirée, fermée, révoquée avec son lien (renouvelé, accès fermé), ou dossier qui n'est
 * plus ouvert au débiteur : `RECOVERY_DEBTOR_SESSION_INVALID` (401), toujours la même erreur. Dossier
 * clos depuis moins de N jours : lecture seule, une écriture répond `RECOVERY_INVALID_TRANSITION`
 * (statut `closed`). Les méthodes de la session s'en servent pour ne lire et n'écrire que ce dossier
 * et ce débiteur.
 */
export class ResolveDebtorSessionUseCase {
  constructor(private readonly deps: Pick<DebtorAccessDeps, 'debtorAccess' | 'clock'>) {}

  async execute(input: { sessionToken: string | null; use?: DebtorSessionUse }): Promise<DebtorSessionScope> {
    requireCaller(GATEWAY_CALLERS);
    const token = input.sessionToken ?? '';
    if (!DEBTOR_TOKEN.test(token)) throw DebtorAccessErrors.sessionInvalid();
    const now = this.deps.clock.now();
    const { store, reader, secrets } = this.deps.debtorAccess;
    const session = await store.findSession(secrets.hashToken(token));
    if (
      !session ||
      session.revokedAt !== null ||
      session.accessRevokedAt !== null ||
      now >= session.expiresAt
    ) {
      throw DebtorAccessErrors.sessionInvalid();
    }
    const caseDebtor = await reader.caseDebtor(session.caseId, session.debtorId);
    const mode = caseDebtor ? accessMode(this.deps, caseDebtor, now) : null;
    if (!mode) throw DebtorAccessErrors.sessionInvalid();
    if (mode === 'read_only' && (input.use ?? 'write') === 'write') throw DebtorAccessErrors.readOnly();
    return {
      caseId: session.caseId,
      debtorId: session.debtorId,
      accessId: session.accessId,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      readOnly: mode === 'read_only',
    };
  }
}

/**
 * Fin de session (EndDebtorSession) : la session présentée est révoquée ; une session déjà fermée,
 * expirée ou inconnue répond `RECOVERY_DEBTOR_SESSION_INVALID`.
 */
export class EndDebtorSessionUseCase {
  private readonly sessions: ResolveDebtorSessionUseCase;

  constructor(private readonly deps: DebtorAccessDeps) {
    this.sessions = new ResolveDebtorSessionUseCase(deps);
  }

  async execute(input: { sessionToken: string | null }): Promise<{ endedAt: Date }> {
    const scope = await this.sessions.execute({ ...input, use: 'read' });
    const now = this.deps.clock.now();
    if (!(await this.deps.debtorAccess.store.endSession(scope.sessionId, now))) {
      throw DebtorAccessErrors.sessionInvalid();
    }
    await this.deps.debtorAccess.journal.record({
      caseId: scope.caseId,
      accessId: scope.accessId,
      occurredAt: now,
      actorType: 'debtor',
      actorId: scope.debtorId,
      action: 'debtor_session_ended',
      channel: null,
      summary: 'Session du débiteur fermée par le débiteur.',
    });
    return { endedAt: now };
  }
}
