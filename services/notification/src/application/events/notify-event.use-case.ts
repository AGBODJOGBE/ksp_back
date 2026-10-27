import { type KspEventType } from '@ksp/contracts';
import { eventDispatchPlans } from '../../domain/channel';
import { EmailAddress, PhoneNumber } from '../../domain/recipient';
import { findTemplate, invalidVariables, isEventTemplate } from '../../domain/template';
import { type MessageDispatcher } from '../send/message-dispatcher';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import {
  type EventInbox,
  type InAppNotification,
  type RecipientContact,
  type RecipientDirectory,
} from './event-notification.ports';
import { type EventRule, type EventRules, type NotificationIntent, type RuleContext } from './event-rules';

/** Partie de l'enveloppe utile au traitement (contrats/events/envelope.schema.json). */
export interface ReceivedEvent {
  eventId: string;
  type: string;
  payload: unknown;
}

export interface NotifyEventResult {
  status: 'processed' | 'duplicate' | 'ignored';
  /** Messages pris en charge par un prestataire. */
  accepted: number;
  /** Messages en échec sur tous les canaux (notification.message.failed publié). */
  failed: number;
  /** Messages déjà traités lors d'une livraison précédente du même événement. */
  replayed: number;
  /** Destinataires introuvables dans identity (compte inconnu ou supprimé). */
  recipientsNotFound: number;
  /** Destinataires sans téléphone ni e-mail : notification dans l'espace seulement. */
  unreachable: number;
  /** Notifications enregistrées dans l'espace KSP. */
  inApp: number;
}

/** Message en français uniquement au lot 2 ; la langue préférée sera prise en compte avec les traductions. */
const LOCALE = 'fr';

/**
 * Notifie les destinataires d'un événement métier (consommateur RabbitMQ, file
 * `notification.<événement>`).
 *
 * 1. Un événement déjà traité (inbox) est ignoré.
 * 2. La règle de l'événement donne les messages à envoyer ; les coordonnées des destinataires sont
 *    lues dans identity. Une panne d'identity lève une erreur : l'événement est repris plus tard
 *    (file de reprise, puis file d'erreurs).
 * 3. Chaque message part par les canaux que fixe sa nature (`eventDispatchPlans`), avec une clé
 *    d'idempotence `<événement>:<modèle>:<destinataire>` : une nouvelle livraison du même événement
 *    n'envoie rien deux fois.
 * 4. L'événement est marqué traité et les notifications dans l'espace sont enregistrées, dans la même
 *    transaction.
 */
export class NotifyEventUseCase {
  constructor(
    private readonly rules: EventRules,
    private readonly dispatcher: MessageDispatcher,
    private readonly directory: RecipientDirectory,
    private readonly inbox: EventInbox,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly context: RuleContext,
  ) {}

  async execute(event: ReceivedEvent): Promise<NotifyEventResult> {
    const result: NotifyEventResult = {
      status: 'processed',
      accepted: 0,
      failed: 0,
      replayed: 0,
      recipientsNotFound: 0,
      unreachable: 0,
      inApp: 0,
    };
    const rule = this.rules[event.type as KspEventType] as EventRule<KspEventType> | undefined;
    if (!rule) return { ...result, status: 'ignored' };
    if (await this.inbox.isProcessed(event.eventId)) return { ...result, status: 'duplicate' };

    const intents = rule(event.payload as never, this.context);
    const contacts = await this.findContacts(intents);
    const inApp: InAppNotification[] = [];

    for (const intent of intents) {
      const contact = contacts.get(intent.userId.toLowerCase());
      if (!contact) {
        result.recipientsNotFound += 1;
        continue;
      }
      const { template, variables } = prepare(intent, contact);
      const content = template.render(variables);
      const now = this.clock.now();
      inApp.push({
        id: this.ids.next(),
        userId: contact.userId,
        templateCode: template.code,
        title: content.subject,
        body: content.text,
        link: intent.link,
        sourceEventId: event.eventId,
        createdAt: now,
      });

      const phone = PhoneNumber.parse(contact.phoneE164 ?? '');
      const email = EmailAddress.parse(contact.email);
      const plans = eventDispatchPlans(template.kind, { hasPhone: phone !== null, hasEmail: email !== null });
      if (plans.length === 0) {
        result.unreachable += 1;
        continue;
      }
      for (const plan of plans) {
        // Un envoi par canal (message important) : la clé porte le canal, pour ne doublonner aucun des deux.
        const single = template.kind === 'important';
        const outcome = await this.dispatcher.dispatch({
          notification: {
            id: this.ids.next(),
            idempotencyKey: `${event.eventId}:${template.code}:${contact.userId}${single ? `:${plan[0]}` : ''}`,
            templateCode: template.code,
            requestedChannel: plan[0],
            targetMasked: [
              plan.includes('whatsapp') ? phone?.masked() : undefined,
              plan.includes('email') ? email?.masked() : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
            recipientUserId: contact.userId,
            createdAt: now,
            expiresAt: null,
          },
          plan,
          message: {
            templateCode: template.code,
            phoneE164: phone?.e164 ?? null,
            email: email?.value ?? null,
            variables,
            content,
            locale: LOCALE,
          },
        });
        if (outcome.kind === 'accepted') result.accepted += 1;
        else if (outcome.kind === 'failed') result.failed += 1;
        else result.replayed += 1;
      }
    }

    const completion = await this.inbox.complete(event.eventId, inApp);
    if (completion === 'duplicate') return { ...result, status: 'duplicate' };
    return { ...result, inApp: inApp.length };
  }

  private async findContacts(intents: readonly NotificationIntent[]): Promise<Map<string, RecipientContact>> {
    const userIds = [...new Set(intents.map((intent) => intent.userId.toLowerCase()))];
    if (userIds.length === 0) return new Map();
    const contacts = await this.directory.findContacts(userIds);
    return new Map(contacts.map((contact) => [contact.userId.toLowerCase(), contact]));
  }
}

/**
 * Modèle et variables complètes d'un message. Un modèle inconnu ou des variables invalides
 * signalent un événement mal formé ou une règle erronée : l'erreur part en file d'erreurs.
 */
function prepare(intent: NotificationIntent, contact: RecipientContact) {
  const template = findTemplate(intent.templateCode);
  if (!template || !isEventTemplate(template)) {
    throw new Error(`modèle de message inconnu : ${intent.templateCode}`);
  }
  const variables = { ...intent.variables, first_name: (contact.firstName ?? '').trim() };
  const invalid = invalidVariables(template, variables);
  if (invalid.length > 0) {
    throw new Error(`variables invalides pour ${template.code} : ${invalid.join(', ')}`);
  }
  return { template, variables };
}
