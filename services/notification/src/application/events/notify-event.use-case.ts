import { type KspEventType } from '@ksp/contracts';
import { type ChannelName, eventDispatchPlans } from '../../domain/channel';
import {
  type ChannelPreferences,
  contactWithPreferences,
  DEFAULT_CHANNEL_PREFERENCES,
  isOptionalMessage,
} from '../../domain/preferences';
import { EmailAddress, PhoneNumber } from '../../domain/recipient';
import { findTemplate, invalidVariables, isEventTemplate } from '../../domain/template';
import { type RecipientPreferences } from '../center/center.ports';
import { type MessageDispatcher } from '../send/message-dispatcher';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import {
  type EventInbox,
  type InAppNotification,
  type OrganizationBillingContact,
  type OrganizationDirectory,
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
  /**
   * Messages facultatifs sans envoi externe parce que le destinataire a écarté ses canaux
   * joignables (ADR-039) : notification dans l'espace seulement.
   */
  optedOut: number;
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
 *    lues dans identity, ainsi que l'e-mail de facturation des organisations concernées (factures
 *    d'une entreprise : il remplace l'adresse du destinataire pour l'e-mail seulement). Une panne
 *    d'identity lève une erreur : l'événement est repris plus tard (file de reprise, puis file
 *    d'erreurs).
 * 3. Chaque message part par les canaux que fixe sa nature (`eventDispatchPlans`), moins ceux que
 *    le destinataire a écartés pour un message facultatif (préférences, ADR-039), avec une clé
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
    private readonly organizations: OrganizationDirectory,
    private readonly preferences: RecipientPreferences,
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
      optedOut: 0,
      inApp: 0,
    };
    const rule = this.rules[event.type as KspEventType] as EventRule<KspEventType> | undefined;
    if (!rule) return { ...result, status: 'ignored' };
    if (await this.inbox.isProcessed(event.eventId)) return { ...result, status: 'duplicate' };

    const intents = rule(event.payload as never, this.context);
    const organizations = await this.findOrganizations(intents);
    const deliveries = recipientsOf(intents, organizations);
    result.recipientsNotFound += deliveries.missingOrganizations;
    const contacts = await this.findContacts(deliveries.intents);
    const preferences = await this.findPreferences(deliveries.intents);
    const inApp: InAppNotification[] = [];

    for (const intent of deliveries.intents) {
      const contact = contacts.get(intent.userId.toLowerCase());
      if (!contact) {
        result.recipientsNotFound += 1;
        continue;
      }
      const organizationId = intent.organizationId ?? intent.billingOrganizationId;
      const organization = organizationId ? organizations.get(organizationId.toLowerCase()) : undefined;
      const { template, variables } = prepare(intent, contact.firstName, organization);
      const content = template.render(variables);
      inApp.push({
        id: this.ids.next(),
        userId: contact.userId,
        templateCode: template.code,
        title: content.subject,
        body: content.text,
        link: intent.link,
        sourceEventId: event.eventId,
        createdAt: this.clock.now(),
      });

      const phone = PhoneNumber.parse(contact.phoneE164 ?? '');
      // Message à l'organisation : l'e-mail de facturation reçoit seul l'e-mail (envoyé à part).
      // Facture d'un client rattachée à une organisation : son e-mail de facturation, sinon l'adresse
      // vérifiée du destinataire.
      const email = intent.organizationId
        ? organization?.billingEmail
          ? null
          : EmailAddress.parse(contact.email)
        : (EmailAddress.parse(organization?.billingEmail) ?? EmailAddress.parse(contact.email));
      const reachable = { hasPhone: phone !== null, hasEmail: email !== null };
      const wanted = contactWithPreferences(
        reachable,
        preferences.get(contact.userId.toLowerCase()) ?? DEFAULT_CHANNEL_PREFERENCES,
        isOptionalMessage(template),
      );
      const plans = eventDispatchPlans(template.kind, wanted);
      if (plans.length === 0) {
        if (reachable.hasPhone || reachable.hasEmail) result.optedOut += 1;
        else result.unreachable += 1;
        continue;
      }
      await this.send(result, event.eventId, template, variables, content, plans, {
        key: contact.userId,
        userId: contact.userId,
        phone,
        email,
      });
    }

    // Une copie par organisation à son e-mail de facturation vérifié (ADR-050).
    for (const intent of deliveries.organizationCopies) {
      const organization = organizations.get(intent.organizationId!.toLowerCase())!;
      const email = EmailAddress.parse(organization.billingEmail);
      if (!email) continue;
      const { template, variables } = prepare(intent, null, organization);
      const plans = eventDispatchPlans(template.kind, { hasPhone: false, hasEmail: true });
      await this.send(result, event.eventId, template, variables, template.render(variables), plans, {
        key: `organization:${organization.organizationId}`,
        userId: null,
        phone: null,
        email,
      });
    }

    const completion = await this.inbox.complete(event.eventId, inApp);
    if (completion === 'duplicate') return { ...result, status: 'duplicate' };
    return { ...result, inApp: inApp.length };
  }

  /** Envoie un message par chacun de ses plans de canaux ; compte les issues dans `result`. */
  private async send(
    result: NotifyEventResult,
    eventId: string,
    template: ReturnType<typeof prepare>['template'],
    variables: Record<string, string>,
    content: ReturnType<ReturnType<typeof prepare>['template']['render']>,
    plans: ChannelName[][],
    to: { key: string; userId: string | null; phone: PhoneNumber | null; email: EmailAddress | null },
  ): Promise<void> {
    for (const plan of plans) {
      // Un envoi par canal (message important) : la clé porte le canal, pour ne doublonner aucun des deux.
      const single = template.kind === 'important';
      const outcome = await this.dispatcher.dispatch({
        notification: {
          id: this.ids.next(),
          idempotencyKey: `${eventId}:${template.code}:${to.key}${single ? `:${plan[0]}` : ''}`,
          templateCode: template.code,
          requestedChannel: plan[0],
          targetMasked: [
            plan.includes('whatsapp') ? to.phone?.masked() : undefined,
            plan.includes('email') ? to.email?.masked() : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
          recipientUserId: to.userId,
          createdAt: this.clock.now(),
          expiresAt: null,
        },
        plan,
        message: {
          templateCode: template.code,
          phoneE164: to.phone?.e164 ?? null,
          email: to.email?.value ?? null,
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

  private async findContacts(intents: readonly NotificationIntent[]): Promise<Map<string, RecipientContact>> {
    const userIds = [...new Set(intents.map((intent) => intent.userId.toLowerCase()))];
    if (userIds.length === 0) return new Map();
    const contacts = await this.directory.findContacts(userIds);
    return new Map(contacts.map((contact) => [contact.userId.toLowerCase(), contact]));
  }

  /** Préférences des destinataires (ADR-039), par identifiant en minuscules ; absent : par défaut. */
  private async findPreferences(
    intents: readonly NotificationIntent[],
  ): Promise<Map<string, ChannelPreferences>> {
    const userIds = [...new Set(intents.map((intent) => intent.userId.toLowerCase()))];
    if (userIds.length === 0) return new Map();
    const found = await this.preferences.findMany(userIds);
    return new Map([...found].map(([userId, value]) => [userId.toLowerCase(), value]));
  }

  /** Fiches de facturation des organisations citées par les messages, par identifiant en minuscules. */
  private async findOrganizations(
    intents: readonly NotificationIntent[],
  ): Promise<Map<string, OrganizationBillingContact>> {
    const organizationIds = [
      ...new Set(
        intents.flatMap((intent) => {
          const organizationId = intent.organizationId ?? intent.billingOrganizationId;
          return organizationId ? [organizationId.toLowerCase()] : [];
        }),
      ),
    ];
    if (organizationIds.length === 0) return new Map();
    const organizations = await this.organizations.findBillingContacts(organizationIds);
    return new Map(
      organizations.map((organization) => [organization.organizationId.toLowerCase(), organization]),
    );
  }
}

/**
 * Modèle et variables complètes d'un message. Un modèle inconnu ou des variables invalides
 * signalent un événement mal formé ou une règle erronée : l'erreur part en file d'erreurs.
 */
function prepare(
  intent: NotificationIntent,
  firstName: string | null,
  organization: OrganizationBillingContact | undefined,
) {
  const template = findTemplate(intent.templateCode);
  if (!template || !isEventTemplate(template)) {
    throw new Error(`modèle de message inconnu : ${intent.templateCode}`);
  }
  const variables = {
    ...intent.variables,
    first_name: (firstName ?? '').trim(),
    ...(organization ? { organization_name: organization.legalName.trim() } : {}),
  };
  const invalid = invalidVariables(template, variables);
  if (invalid.length > 0) {
    throw new Error(`variables invalides pour ${template.code} : ${invalid.join(', ')}`);
  }
  return { template, variables };
}

/**
 * Destinataires des messages : un message adressé à une organisation (`organizationId`) va à chacun
 * de ses administrateurs actuels, et donne une copie pour son e-mail de facturation (ADR-050) ;
 * organisation introuvable : personne. Les autres messages vont à leur `userId`.
 */
function recipientsOf(
  intents: readonly NotificationIntent[],
  organizations: ReadonlyMap<string, OrganizationBillingContact>,
): { intents: NotificationIntent[]; organizationCopies: NotificationIntent[]; missingOrganizations: number } {
  const expanded: NotificationIntent[] = [];
  const organizationCopies: NotificationIntent[] = [];
  let missingOrganizations = 0;
  for (const intent of intents) {
    if (!intent.organizationId) {
      expanded.push(intent);
      continue;
    }
    const organization = organizations.get(intent.organizationId.toLowerCase());
    if (!organization) {
      missingOrganizations += 1;
      continue;
    }
    expanded.push(...organization.adminUserIds.map((userId) => ({ ...intent, userId })));
    if (organization.billingEmail) organizationCopies.push(intent);
  }
  return { intents: expanded, organizationCopies, missingOrganizations };
}
