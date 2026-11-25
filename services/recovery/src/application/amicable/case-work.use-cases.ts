import { addDays, localDay, localInstant, type LocalDay } from '../../domain/calendar';
import { isWithinContactWindow, nextContactInstant } from '../../domain/contact-policy';
import { amicableStepsDue, DEFAULT_AMICABLE_SEQUENCE } from '../../domain/progression';
import { newPromise } from '../../domain/promise';
import { UUID } from '../cases/case-input';
import { requireCaseInScope } from '../cases/case-access';
import { agentActor, amountDue, evidenceEntry, requireIdempotencyKey, stableId } from '../cases/case-rules';
import { type CaseSummaryView, summaryViews } from '../cases/case-views';
import { caseSubject, journalView, type JournalView, requireCaseId } from '../cases/creditor-cases.use-cases';
import { type EvidenceEntryData, noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { type DebtorChannel, type DebtorMessage } from '../ports';
import { loadSettings } from '../settings.use-cases';
import { BACKOFFICE_MFA_SECONDS, requireStaff, type Staff } from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import {
  type AmicableDeps,
  type AmicableFollowUp,
  type ContactChannelKind,
  type ContactOutcome,
  type ContactRecord,
  noAmicableChanges,
  type PromiseRecord,
  type WorkItemKind,
} from './amicable.ports';
import {
  AmicableErrors,
  CASE_WORKERS,
  commitAction,
  mainDebtor,
  optionalInstant,
  optionalText,
  PLAN_REVIEWERS,
  requireActive,
  requireDay,
  requireOpen,
} from './amicable-rules';
import { amountText, DebtorMessenger, longDay, queuedMessage } from './debtor-messages';

const CONTACT_CHANNELS: readonly ContactChannelKind[] = [
  'phone',
  'sms',
  'whatsapp',
  'email',
  'letter',
  'visit',
];
const CONTACT_OUTCOMES: readonly ContactOutcome[] = [
  'reached',
  'no_answer',
  'wrong_number',
  'refused',
  'promise',
  'callback_requested',
  'delivered',
  'failed',
];
const CHANNEL_LABELS: Record<ContactChannelKind, string> = {
  phone: 'Appel',
  sms: 'SMS',
  whatsapp: 'Message WhatsApp',
  email: 'E-mail',
  letter: 'Courrier',
  visit: 'Visite',
};
const OUTCOME_LABELS: Record<ContactOutcome, string> = {
  reached: 'débiteur joint',
  no_answer: 'pas de réponse',
  wrong_number: 'mauvais numéro',
  refused: 'refus de payer',
  promise: 'promesse de paiement',
  callback_requested: 'rappel demandé',
  delivered: 'remis',
  failed: 'échec',
};
/** Contacts qui sollicitent le débiteur : soumis aux plages de contact (un courrier ne l'est pas). */
const SOLICITING: ReadonlySet<ContactChannelKind> = new Set(['phone', 'sms', 'whatsapp', 'email', 'visit']);
/** Contacts qui soldent un rappel promis. */
const CALLING: ReadonlySet<ContactChannelKind> = new Set(['phone', 'whatsapp', 'visit']);
/** Saisie d'un contact passé : au plus 30 jours en arrière, 5 minutes d'avance d'horloge tolérées. */
const CONTACT_PAST_DAYS = 30;
const CLOCK_SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

function choice<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T))
    throw RecoveryErrors.invalid(field, `Valeur attendue : ${allowed.join(', ')}.`);
  return value as T;
}

function debtorOf(record: RecoveryCaseRecord, debtorId: string) {
  if (!debtorId) return null;
  const debtor = record.debtors.find((candidate) => candidate.id === debtorId.toLowerCase());
  if (!debtor) throw RecoveryErrors.invalid('debtorId', 'Débiteur inconnu dans ce dossier.');
  return debtor;
}

async function entryView(deps: AmicableDeps, entry: EvidenceEntryData): Promise<JournalView> {
  return journalView(deps, [entry], null);
}

/**
 * Contact avec le débiteur (RecordContact, UC-RC-16) : appel, message, courrier ou visite et son
 * résultat, saisi par le chargé ; un rappel promis entre dans « Ma journée ». Un contact sortant
 * hors des plages de contact est refusé (`RECOVERY_CONTACT_OUTSIDE_HOURS`, prochain instant permis),
 * comme un rappel promis hors plage. La note reste au contact : le journal ne porte que des faits.
 * Rejouée avec la même clé, elle rend la même entrée.
 */
export class RecordContactUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    debtorId: string;
    channel: string;
    direction: string;
    outcome: string;
    note: string;
    occurredAt: string;
    callbackAt: string;
    fileId: string;
  }): Promise<JournalView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_WORKERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const contactId = stableId('recovery-contact', record.id, staff.userId, key);
    const evidenceId = stableId('recovery-contact-evidence', contactId);
    if (await this.deps.amicable.contact(contactId)) {
      const known = await this.deps.amicable.evidence(evidenceId);
      if (known) return entryView(this.deps, known);
    }
    requireOpen(record);
    const channel = choice('channel', input.channel, CONTACT_CHANNELS);
    const direction = choice('direction', input.direction, ['outbound', 'inbound'] as const);
    const outcome = choice('outcome', input.outcome, CONTACT_OUTCOMES);
    const debtor = debtorOf(record, input.debtorId);
    const note = optionalText('note', input.note, 2000);
    const occurredAt = optionalInstant('occurredAt', input.occurredAt) ?? now;
    if (
      occurredAt.getTime() > now.getTime() + CLOCK_SKEW_MS ||
      now.getTime() - occurredAt.getTime() > CONTACT_PAST_DAYS * DAY_MS
    ) {
      throw RecoveryErrors.invalid('occurredAt', `Contact des ${CONTACT_PAST_DAYS} derniers jours.`);
    }
    const { settings } = await loadSettings(this.deps.settings);
    const window = settings.contactWindow;
    if (direction === 'outbound' && SOLICITING.has(channel) && !isWithinContactWindow(occurredAt, window)) {
      throw AmicableErrors.contactOutsideHours(nextContactInstant(occurredAt, window));
    }
    const callbackAt = optionalInstant('callbackAt', input.callbackAt);
    if (callbackAt) {
      if (callbackAt <= now) throw RecoveryErrors.invalid('callbackAt', 'Rappel à une date à venir.');
      if (!isWithinContactWindow(callbackAt, window)) {
        throw AmicableErrors.contactOutsideHours(nextContactInstant(callbackAt, window));
      }
    }
    let fileId: string | null = null;
    if (input.fileId) {
      if (!UUID.test(input.fileId)) throw RecoveryErrors.invalid('fileId', 'Identifiant invalide.');
      fileId = (
        await this.deps.files.attach({
          fileId: input.fileId.toLowerCase(),
          subject: caseSubject(record.id),
          ownerId: staff.userId,
        })
      ).fileId;
    }

    const actor = agentActor(staff.userId);
    const contact: ContactRecord = {
      id: contactId,
      caseId: record.id,
      debtorId: debtor?.id ?? null,
      channel,
      direction,
      outcome,
      deliveryStatus: null,
      note,
      occurredAt,
      by: actor,
      internal: false,
      callbackAt,
      callbackDoneAt: null,
      fileId,
    };
    const summary =
      `${CHANNEL_LABELS[channel]} ${direction === 'outbound' ? 'sortant' : 'entrant'} : ${OUTCOME_LABELS[outcome]}` +
      (callbackAt ? ` ; rappel promis le ${longDay(localDay(callbackAt))}` : '');
    const entry: EvidenceEntryData = {
      ...evidenceEntry(this.deps.ids, record, occurredAt, actor, {
        action: 'contact.recorded',
        kind: 'contact',
        summary,
        ...(fileId ? { ref: { type: 'file' as const, id: fileId } } : {}),
      }),
      id: evidenceId,
      channel,
      direction,
      outcome,
    };
    const changes = noChanges();
    changes.evidence.push(entry);
    const amicable = noAmicableChanges();
    amicable.contacts.push(contact);
    if (direction === 'outbound' && CALLING.has(channel)) {
      // Le rappel promis pour ce jour (ou avant) est fait ; celui de ce contact reste à faire.
      amicable.callbacksDone.push({
        caseId: record.id,
        until: localInstant(addDays(localDay(occurredAt), 1), 0),
        at: now,
      });
    }
    await commitAction(this.deps, { touch: { caseId: record.id, at: now }, changes, amicable });
    return entryView(this.deps, entry);
  }
}

/**
 * Promesse de paiement (RecordPromise, R-PR-09) : montant (au plus le dû) et jour à venir. La tâche
 * la déclare tenue dès que les encaissements reçus depuis l'atteignent, ou non tenue le lendemain du
 * jour promis (relance au débiteur et entrée dans « Ma journée »).
 */
export class RecordPromiseUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    amount: number | null;
    dueDate: string;
    note: string;
  }): Promise<PromiseRecord> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_WORKERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const id = stableId('recovery-promise', record.id, staff.userId, key);
    const known = await this.deps.amicable.promise(id);
    if (known) return known;
    requireActive(record);
    const due = amountDue(record);
    const amount = input.amount ?? 0;
    const promise = unwrap(newPromise(amount, requireDay('dueDate', input.dueDate), localDay(now)));
    if (promise.amount > due) {
      throw RecoveryErrors.invalid('amount', `Au plus le montant dû, ${formatXof(due)}.`);
    }
    const row: PromiseRecord = {
      id,
      caseId: record.id,
      amount: promise.amount,
      dueDate: promise.dueDate,
      status: 'pending',
      createdBy: staff.userId,
      note: optionalText('note', input.note, 1000),
      keptAt: null,
      brokenAt: null,
      createdAt: now,
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, agentActor(staff.userId), {
        action: 'promise.recorded',
        kind: 'promise',
        summary: `Promesse de paiement de ${formatXof(row.amount)} pour le ${longDay(row.dueDate)}`,
        amount: row.amount,
      }),
    );
    const amicable = noAmicableChanges();
    amicable.promises.push({ row, expected: null });
    await commitAction(this.deps, { touch: { caseId: record.id, at: now }, changes, amicable });
    return row;
  }
}

/** Note interne (AddInternalNote, R-PR-08) : au journal, jamais montrée au créancier ni au débiteur. */
export class AddInternalNoteUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: { caseId: string; text: string }): Promise<JournalView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_WORKERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    if (record.status === 'draft' || record.status === 'awaiting_fee') {
      throw RecoveryErrors.invalid('caseId', 'Le dossier n’est pas encore envoyé à KSP.');
    }
    const text = optionalText('text', input.text, 4000);
    if (!text) throw RecoveryErrors.invalid('text', 'Note de 1 à 4 000 caractères.');
    const entry = evidenceEntry(this.deps.ids, record, now, agentActor(staff.userId), {
      action: 'note.added',
      kind: 'note',
      summary: text,
      internal: true,
    });
    const changes = noChanges();
    changes.evidence.push(entry);
    await commitAction(this.deps, {
      touch: { caseId: record.id, at: now },
      changes,
      amicable: noAmicableChanges(),
    });
    return entryView(this.deps, entry);
  }
}

/** Modèles du chargé (`SendDebtorMessageRequest.template`) et message de notification correspondant. */
const MANUAL_TEMPLATES: Record<string, DebtorMessage> = {
  reminder: 'reminder',
  payment_link: 'payment_link',
  plan_reminder: 'installment_reminder',
  // Pas de modèle propre au rappel manqué chez notification : la relance porte le lien, d'où le
  // débiteur demande un nouveau créneau.
  callback_missed: 'reminder',
};

/**
 * Message au débiteur depuis un modèle validé (SendDebtorMessage, UC-RC-18) : dans la plage de contact
 * seulement (`RECOVERY_CONTACT_OUTSIDE_HOURS` sinon), lien personnel renouvelé, canal demandé ou ordre
 * réglé du service. Le SMS n'est pas un canal de notification pour le débiteur (WhatsApp ou e-mail).
 * Rejoué avec la même clé, il rend l'entrée du journal sans renvoyer.
 */
export class SendDebtorMessageUseCase {
  private readonly messenger: DebtorMessenger;

  constructor(private readonly deps: AmicableDeps) {
    this.messenger = new DebtorMessenger(deps);
  }

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    debtorId: string;
    template: string;
    channel: string;
  }): Promise<JournalView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_WORKERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const dedupeKey = `manual:${record.id}:${stableId(staff.userId, key)}`;
    const evidenceId = stableId('recovery-message-evidence', dedupeKey);
    if (await this.deps.amicable.message(dedupeKey)) {
      const known = await this.deps.amicable.evidence(evidenceId);
      if (known) return entryView(this.deps, known);
    }
    requireActive(record);
    const message = MANUAL_TEMPLATES[input.template];
    if (!message) {
      throw RecoveryErrors.invalid(
        'template',
        'Valeur attendue : reminder, payment_link, plan_reminder, callback_missed.',
      );
    }
    let channel: DebtorChannel | null = null;
    if (input.channel) {
      if (input.channel === 'sms')
        throw RecoveryErrors.invalid('channel', 'SMS indisponible : WhatsApp ou e-mail.');
      channel = choice('channel', input.channel, ['whatsapp', 'email'] as const);
    }
    const debtor = debtorOf(record, input.debtorId) ?? mainDebtor(record);
    const { settings } = await loadSettings(this.deps.settings);
    if (!isWithinContactWindow(now, settings.contactWindow)) {
      throw AmicableErrors.contactOutsideHours(nextContactInstant(now, settings.contactWindow));
    }
    const variables: Record<string, string> = {};
    if (message === 'installment_reminder') {
      const plan = (await this.deps.amicable.plans(record.id)).find(
        (candidate) => candidate.status === 'signed',
      );
      const next = plan?.installments.find((installment) => installment.paidAmount < installment.amount);
      if (!next)
        throw RecoveryErrors.invalid(
          'template',
          'Aucune échéance à venir : pas d’échéancier signé en cours.',
        );
      variables['amount'] = amountText(next.amount - next.paidAmount);
      variables['due_on'] = longDay(next.dueDate);
    }
    const outcome = await this.messenger.deliver(
      record,
      queuedMessage(this.deps.ids, {
        caseId: record.id,
        debtorId: debtor.id,
        message,
        purpose: 'manual',
        dedupeKey,
        notBefore: now,
        variables,
        channel,
      }),
      { stored: false, actor: agentActor(staff.userId), evidenceId },
    );
    if (outcome.status === 'unreachable') {
      throw RecoveryErrors.invalid('channel', 'Aucune coordonnée valable du débiteur pour ce canal.');
    }
    const entry = await this.deps.amicable.evidence(evidenceId);
    if (!entry) throw new Error('Entrée du journal introuvable après l’envoi.');
    return entryView(this.deps, entry);
  }
}

export interface WorkItemView {
  kind: WorkItemKind;
  summary: CaseSummaryView;
  dueAt: Date;
  note: string;
}

const STEP_NOTES = {
  message: 'Message de relance amiable',
  call: 'Appel de relance amiable',
  letter_or_email: 'Courrier de relance amiable (pas d’e-mail du débiteur)',
  visit: 'Visite de relance amiable',
} as const;

/** Pas de la séquence de relance faits à la main : appel, courrier (ou e-mail), visite, depuis son jour. */
function manualStepsDue(followUp: AmicableFollowUp, day: LocalDay) {
  const done = new Set(followUp.automaticSteps);
  DEFAULT_AMICABLE_SEQUENCE.forEach((step, index) => {
    if (step.action === 'message') done.add(index);
    const from = localInstant(addDays(localDay(followUp.startedAt), step.offsetDays), 0);
    const channels: readonly ContactChannelKind[] =
      step.action === 'letter_or_email'
        ? ['letter', 'email']
        : step.action === 'visit'
          ? ['visit']
          : ['phone', 'visit'];
    if (
      followUp.outboundContacts.some(
        (contact) => channels.includes(contact.channel) && contact.occurredAt >= from,
      )
    ) {
      done.add(index);
    }
  });
  return amicableStepsDue(localDay(followUp.startedAt), day, done).filter(
    (step) => step.action !== 'message',
  );
}

/**
 * « Ma journée » du chargé (GetMyWorkQueue, 14.6) : rappels promis, promesses non tenues, échéances
 * manquées, pas de la relance amiable à faire (appels, courriers), rappels demandés par le débiteur,
 * contestations, sur ses dossiers ; un superviseur y voit aussi les échéanciers hors barème à valider.
 * Triée par échéance, jusqu'à la fin du jour demandé.
 */
export class GetMyWorkQueueUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: { day: string }): Promise<WorkItemView[]> {
    const now = this.deps.clock.now();
    const staff: Staff = requireStaff(CASE_WORKERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const day = input.day ? requireDay('day', input.day) : localDay(now);
    const until = localInstant(addDays(day, 1), 0);
    const reviewer = PLAN_REVIEWERS.some((role) => staff.roles.has(role));
    const rows = await this.deps.amicable.workQueue(
      { agentId: staff.userId, plansToValidate: reviewer },
      until,
    );
    for (const followUp of await this.deps.amicable.amicableFollowUps(staff.userId, 200)) {
      for (const step of manualStepsDue(followUp, day)) {
        rows.push({
          kind: 'reminder_due',
          caseId: followUp.caseId,
          dueAt: localInstant(step.day, 8),
          note: `${STEP_NOTES[step.action]} (J${step.offsetDays})`,
        });
      }
    }
    if (rows.length === 0) return [];
    const { settings } = await loadSettings(this.deps.settings);
    const summaries = await summaryViews(
      this.deps,
      await this.deps.amicable.summaries([...new Set(rows.map((row) => row.caseId))]),
      settings,
      now,
    );
    const byCase = new Map(summaries.map((view) => [view.summary.id, view]));
    return rows
      .filter((row) => byCase.has(row.caseId))
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.kind.localeCompare(b.kind))
      .map((row) => ({ kind: row.kind, summary: byCase.get(row.caseId)!, dueAt: row.dueAt, note: row.note }));
  }
}
