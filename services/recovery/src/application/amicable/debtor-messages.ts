import { pickChannel } from '../../domain/amicable';
import { localDay, type LocalDay } from '../../domain/calendar';
import { amountDue, evidenceEntry, SYSTEM } from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { type EvidenceActor, noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { DebtorLinks } from '../debtor-access/debtor-links.service';
import { type DebtorChannel, type DebtorMessage, type IdGenerator } from '../ports';
import { RecoveryErrors } from '../shared/errors';
import {
  type AmicableDeps,
  type ContactRecord,
  type DebtorMessageRecord,
  type MessagePurpose,
  noAmicableChanges,
} from './amicable.ports';
import { coordinatesOf } from './amicable-rules';

/** Réservation d'un message par une instance de la tâche ; au-delà, une autre peut le reprendre. */
export const MESSAGE_LEASE_MS = 5 * 60_000;
/** Essais d'envoi d'un message avant de le déclarer en échec. */
export const MESSAGE_MAX_ATTEMPTS = 5;

const PURPOSE_LABELS: Record<MessagePurpose, string> = {
  notice: 'Notification du mandat',
  amicable_step: 'Relance amiable',
  promise_followup: 'Relance après une promesse non tenue',
  installment_reminder: 'Rappel d’échéance',
  plan_confirmed: 'Confirmation de l’échéancier signé',
  manual: 'Message du chargé',
};

const CHANNEL_LABELS: Record<DebtorChannel, string> = { whatsapp: 'WhatsApp', email: 'e-mail' };

/**
 * Montant au format des modèles de notification : chiffres groupés par trois, espaces insécables
 * (« 25 000 FCFA »).
 */
export function amountText(amount: number): string {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0FCFA`;
}

const LONG_DAY = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Jour en toutes lettres : « 15 décembre 2026 ». */
export function longDay(day: LocalDay): string {
  return LONG_DAY.format(new Date(`${day}T00:00:00.000Z`));
}

/** Nouveau message en file, envoyé par la tâche dès que la plage de contact le permet. */
export function queuedMessage(
  ids: IdGenerator,
  input: {
    caseId: string;
    debtorId: string;
    message: DebtorMessage;
    purpose: MessagePurpose;
    dedupeKey: string;
    notBefore: Date;
    variables?: Record<string, string>;
    refId?: string | null;
    channel?: DebtorChannel | null;
  },
): DebtorMessageRecord {
  return {
    id: ids.next(),
    caseId: input.caseId,
    debtorId: input.debtorId,
    message: input.message,
    purpose: input.purpose,
    dedupeKey: input.dedupeKey,
    variables: input.variables ?? {},
    refId: input.refId ?? null,
    channel: input.channel ?? null,
    notBefore: input.notBefore,
    status: 'pending',
    attempts: 0,
    notificationId: null,
    sentAt: null,
    createdAt: input.notBefore,
  };
}

export type DeliveryOutcome =
  | { status: 'sent'; channel: DebtorChannel; evidenceId: string; linkExpiresAt: Date }
  | { status: 'unreachable' };

/**
 * Envoi d'un message au débiteur (ADR-061) : un lien personnel neuf (l'ancien est révoqué : « lien
 * renouvelé à chaque relance »), le canal choisi dans l'ordre réglé, puis l'appel à notification avec
 * les coordonnées du dossier, jamais conservées ailleurs. L'envoi réussi entre au journal de preuve
 * (message envoyé, canal, statut de remise) et dans les contacts, avec la ligne de la file.
 */
export class DebtorMessenger {
  private readonly links: DebtorLinks;

  constructor(private readonly deps: AmicableDeps) {
    this.links = new DebtorLinks(deps);
  }

  /**
   * Envoie un message, déjà en file (`stored`) ou nouveau (message du chargé). `unreachable` : aucune
   * coordonnée pour le canal demandé ou l'ordre réglé. Une panne de notification (ou du lien) remonte :
   * la file le reprendra, le chargé réessaiera.
   */
  async deliver(
    record: RecoveryCaseRecord,
    message: DebtorMessageRecord,
    options: { stored: boolean; actor?: EvidenceActor; evidenceId?: string },
  ): Promise<DeliveryOutcome> {
    const actor = options.actor ?? SYSTEM;
    const debtor = record.debtors.find((candidate) => candidate.id === message.debtorId);
    if (!debtor) throw RecoveryErrors.invalid('debtorId', 'Débiteur inconnu dans ce dossier.');
    const { phone, email } = coordinatesOf(debtor);
    const available = { phone: phone !== null, email: email !== null };
    const channel = message.channel
      ? pickChannel([message.channel], available)
      : pickChannel(this.deps.amicableOptions.debtorChannels, available);
    if (!channel) return { status: 'unreachable' };

    const link = await this.links.issue({ caseId: record.id, debtorId: debtor.id });
    const variables = await this.variables(record, message, link.url, link.expiresAt);
    if (debtor.kind === 'person' && debtor.firstNames)
      variables['first_name'] = debtor.firstNames.slice(0, 100);
    const sent = await this.deps.notifier.sendToDebtor({
      message: message.message,
      channel,
      phone,
      email,
      variables,
      // Une clé par lien : un renvoi après une panne porte le nouveau lien, jamais l'ancien révoqué.
      idempotencyKey: `${message.dedupeKey}:${link.accessId}`,
    });

    const now = this.deps.clock.now();
    const evidence = {
      ...evidenceEntry(this.deps.ids, record, now, actor, {
        action: `message.${message.purpose}`,
        kind: 'message_sent',
        summary:
          `${PURPOSE_LABELS[message.purpose]} envoyée par ${CHANNEL_LABELS[channel]}, avec le lien personnel ` +
          `du débiteur (valable jusqu’au ${longDay(localDay(link.expiresAt))})`,
      }),
      ...(options.evidenceId ? { id: options.evidenceId } : {}),
      channel,
      direction: 'outbound' as const,
      deliveryStatus: 'sent',
    };
    const contact: ContactRecord = {
      id: this.deps.ids.next(),
      caseId: record.id,
      debtorId: debtor.id,
      channel,
      direction: 'outbound',
      outcome: null,
      deliveryStatus: 'sent',
      note: null,
      occurredAt: now,
      by: actor,
      internal: false,
      callbackAt: null,
      callbackDoneAt: null,
      fileId: null,
    };
    const changes = noChanges();
    changes.evidence.push(evidence);
    const amicable = noAmicableChanges();
    amicable.contacts.push(contact);
    const delivered: DebtorMessageRecord = {
      ...message,
      status: 'sent',
      channel,
      notificationId: sent.notificationId,
      sentAt: now,
    };
    if (options.stored) amicable.messageUpdates.push(delivered);
    else amicable.messages.push(delivered);
    await this.deps.amicable.commit({ touch: { caseId: record.id, at: now }, changes, amicable });
    return { status: 'sent', channel, evidenceId: evidence.id, linkExpiresAt: link.expiresAt };
  }

  /** Variables du modèle : nom du créancier (seule donnée du créancier montrée), dossier, montants, lien. */
  private async variables(
    record: RecoveryCaseRecord,
    message: DebtorMessageRecord,
    url: string,
    expiresAt: Date,
  ): Promise<Record<string, string>> {
    const names = await displayNames(this.deps.directory, [record.creditor], []);
    const due = amountText(amountDue(record));
    const expiresOn = longDay(localDay(expiresAt));
    return {
      creditor_name: (names.holder(record.creditor) || 'votre créancier').slice(0, 200),
      case_number: record.number,
      amount_due: due,
      amount: due,
      link: url,
      link_expires_on: expiresOn,
      expires_on: expiresOn,
      ...message.variables,
    };
  }
}
