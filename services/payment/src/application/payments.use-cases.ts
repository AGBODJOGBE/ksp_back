import { type DueRefusal, invoiceAmount, missionAmount } from '../domain/amount-due';
import {
  MISSION_PARTS,
  type MissionPart,
  PAYMENT_STATUSES,
  type PaymentIntent,
  type PaymentSubject,
  sameSubject,
  SUBJECT_TYPES,
  type SubjectType,
} from '../domain/payment-intent';
import { type NotificationOutcome, type PageRequest, type PageResult, type PaymentDeps } from './ports';
import { currentPayer, isVisibleTo, PAYMENT_STAFF, requireCaller, requireStaff } from './shared/access';
import { PaymentErrors } from './shared/errors';
import { IDEMPOTENCY_KEY, oneOf, optionalOneOf, optionalUuid, requireUuid } from './shared/validation';
import { PaymentSync } from './sync';

const MINUTE_MS = 60_000;

function refusalError(refusal: DueRefusal) {
  switch (refusal) {
    case 'not_found':
      return PaymentErrors.subjectNotFound();
    case 'via_invoice':
      return PaymentErrors.viaInvoice();
    case 'not_payable':
      return PaymentErrors.notPayable();
    case 'nothing_due':
      return PaymentErrors.nothingDue();
  }
}

/** Paiement visible par l'appelant, sinon introuvable (404). */
async function visiblePayment(deps: PaymentDeps, paymentId: string): Promise<PaymentIntent> {
  const payer = currentPayer();
  const intent = await deps.payments.findById(requireUuid('paymentId', paymentId));
  if (!intent || !isVisibleTo(intent, payer)) throw PaymentErrors.notFound();
  return intent;
}

/**
 * Création d'un paiement (ADR-031) : montant dû lu dans cleaning ou billing, payeur vérifié,
 * idempotence par (payeur, clé), réutilisation d'un paiement encore en attente pour le même objet
 * et le même montant, puis page de paiement chez le prestataire.
 */
export class CreatePaymentUseCase {
  private readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  async execute(input: {
    subjectType: string;
    subjectId: string;
    part: string;
    idempotencyKey: string;
  }): Promise<{ payment: PaymentIntent; created: boolean }> {
    const payer = currentPayer();
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw PaymentErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const type = oneOf<SubjectType>('subjectType', input.subjectType, SUBJECT_TYPES);
    const subjectId = requireUuid('subjectId', input.subjectId);
    let part: MissionPart | null = null;
    if (type === 'cleaning_mission') part = oneOf('part', input.part, MISSION_PARTS);
    else if (input.part) throw PaymentErrors.invalid('part', 'Une facture se règle sans part.');

    // Rejeu : même clé, même objet → même paiement (page reprise si elle manquait).
    const replay = await this.deps.payments.findByIdempotencyKey(payer.userId, input.idempotencyKey);
    if (replay) {
      if (!sameSubject(replay.subject, { type, id: subjectId, part })) throw PaymentErrors.keyReused();
      return { payment: await this.withCheckout(replay), created: false };
    }

    const { amount, subject, organizationId } = await this.amountDue(type, subjectId, part, payer);
    const now = this.deps.clock.now();
    const open = await this.deps.payments.findOpen({
      customerId: payer.userId,
      subjectType: type,
      subjectId,
      part,
      now,
    });
    if (open && open.amount === amount) return { payment: await this.withCheckout(open), created: false };
    // Montant dû changé (paiement reçu entre-temps) : l'ancienne page ne doit plus être payée.
    if (open) await this.sync.supersede(open);

    const draft: PaymentIntent = {
      id: this.deps.ids.next(),
      subject,
      amount,
      customerId: payer.userId,
      organizationId,
      status: 'pending',
      provider: this.deps.provider.name,
      providerTransactionId: null,
      providerReference: null,
      checkoutUrl: null,
      idempotencyKey: input.idempotencyKey,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + this.deps.settings.intentTtlMinutes * MINUTE_MS),
      completedAt: null,
      lastCheckedAt: null,
      version: 0,
    };
    const stored = await this.deps.payments.create(draft);
    if (!stored.created && !sameSubject(stored.intent.subject, subject)) throw PaymentErrors.keyReused();
    return { payment: await this.withCheckout(stored.intent), created: stored.created };
  }

  private async amountDue(
    type: SubjectType,
    subjectId: string,
    part: MissionPart | null,
    payer: ReturnType<typeof currentPayer>,
  ): Promise<{ amount: number; subject: PaymentSubject; organizationId: string | null }> {
    if (type === 'cleaning_mission') {
      const due = await this.deps.dues.missionDue(subjectId);
      if (!due) throw PaymentErrors.subjectNotFound();
      const result = missionAmount(due, part!, payer);
      if ('refusal' in result) throw refusalError(result.refusal);
      return {
        amount: result.amount,
        subject: { type, id: subjectId, part, reference: null },
        organizationId: null,
      };
    }
    const due = await this.deps.dues.invoiceDue(subjectId);
    if (!due) throw PaymentErrors.subjectNotFound();
    const result = invoiceAmount(due, payer);
    if ('refusal' in result) throw refusalError(result.refusal);
    return {
      amount: result.amount,
      subject: { type, id: subjectId, part: null, reference: due.number },
      organizationId: due.organizationId,
    };
  }

  /** Paiement en attente sans page (prestataire en panne au premier essai) : nouvel essai. */
  private withCheckout(intent: PaymentIntent): Promise<PaymentIntent> | PaymentIntent {
    if (intent.status !== 'pending' || intent.checkoutUrl) return intent;
    if (intent.expiresAt <= this.deps.clock.now()) return this.sync.expire(intent);
    return this.sync.startCheckout(intent);
  }
}

/**
 * Statut d'un paiement, consulté au retour de la page de paiement. En attente : le prestataire est
 * interrogé au passage (au plus une fois par intervalle) ; s'il ne répond pas, le dernier statut
 * connu est renvoyé (la notification ou la tâche de rapprochement prendront le relais).
 */
export class GetMyPaymentUseCase {
  private readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  async execute(paymentId: string): Promise<PaymentIntent> {
    const intent = await visiblePayment(this.deps, paymentId);
    if (intent.status !== 'pending' || !intent.providerTransactionId) return intent;
    const now = this.deps.clock.now().getTime();
    const recheckMs = this.deps.settings.recheckAfterSeconds * 1000;
    if (intent.lastCheckedAt && now - intent.lastCheckedAt.getTime() < recheckMs) return intent;
    try {
      return (await this.sync.refresh(intent)).intent;
    } catch {
      return intent;
    }
  }
}

/** Mes paiements : ceux de l'organisation active, ou les miens hors organisation. */
export class ListMyPaymentsUseCase {
  constructor(private readonly deps: PaymentDeps) {}

  async execute(input: { page: PageRequest; status: string }): Promise<PageResult<PaymentIntent>> {
    const payer = currentPayer();
    const status = optionalOneOf('status', input.status, PAYMENT_STATUSES);
    return this.deps.payments.list(
      {
        ...(payer.organizationId
          ? { organizationId: payer.organizationId }
          : { customerId: payer.userId, organizationId: null }),
        ...(status ? { status } : {}),
      },
      input.page,
    );
  }
}

/** Back-office : tous les paiements, filtrables. */
export class ListPaymentsUseCase {
  constructor(private readonly deps: PaymentDeps) {}

  async execute(input: {
    page: PageRequest;
    status: string;
    subjectType: string;
    subjectId: string;
    customerId: string;
    organizationId: string;
  }): Promise<PageResult<PaymentIntent>> {
    requireStaff(PAYMENT_STAFF);
    const status = optionalOneOf('status', input.status, PAYMENT_STATUSES);
    const subjectType = optionalOneOf('subjectType', input.subjectType, SUBJECT_TYPES);
    const subjectId = optionalUuid('subjectId', input.subjectId);
    const customerId = optionalUuid('customerId', input.customerId);
    const organizationId = optionalUuid('organizationId', input.organizationId);
    return this.deps.payments.list(
      {
        ...(status ? { status } : {}),
        ...(subjectType ? { subjectType } : {}),
        ...(subjectId ? { subjectId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(organizationId ? { organizationId } : {}),
      },
      input.page,
    );
  }
}

/**
 * Notification du prestataire, relayée par la gateway : signature vérifiée sur le corps exact, puis
 * transaction relue chez le prestataire (le contenu de la notification n'est pas cru tel quel).
 * Transaction inconnue : sans effet. Chaque notification est journalisée, sans son corps.
 */
export class ReceiveProviderNotificationUseCase {
  private readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  async execute(input: {
    provider: string;
    payload: Uint8Array;
    signature: string;
  }): Promise<NotificationOutcome> {
    requireCaller(['gateway']);
    const provider = this.deps.provider;
    if (input.provider !== provider.name) {
      throw PaymentErrors.invalid('provider', 'Ce prestataire de paiement n’est pas configuré.');
    }
    const receivedAt = this.deps.clock.now();
    const notification = provider.verifyNotification(input.payload, input.signature, receivedAt);
    let outcome: NotificationOutcome = 'ignored';
    let paymentId: string | null = null;
    if (notification.transactionId) {
      const intent = await this.deps.payments.findByTransaction(provider.name, notification.transactionId);
      if (!intent) outcome = 'unknown_transaction';
      else {
        paymentId = intent.id;
        outcome = (await this.sync.refresh(intent)).outcome;
      }
    }
    await this.deps.notifications.record({
      id: this.deps.ids.next(),
      provider: provider.name,
      eventName: notification.eventName.slice(0, 100),
      providerEventId: notification.eventId,
      providerTransactionId: notification.transactionId,
      paymentId,
      outcome,
      receivedAt,
    });
    return outcome;
  }
}

/**
 * Développement seulement : joue le rôle de la page de paiement du prestataire simulé (règle ou
 * refuse la transaction chez lui), puis confirme par le même chemin qu'une notification.
 */
export class SimulatePaymentUseCase {
  private readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  async execute(input: { paymentId: string; outcome: string }): Promise<PaymentIntent> {
    const settle = this.deps.provider.settle?.bind(this.deps.provider);
    if (!this.deps.settings.simulationEnabled || !settle) throw PaymentErrors.simulationDisabled();
    const outcome = oneOf<'succeeded' | 'failed'>('outcome', input.outcome, ['succeeded', 'failed']);
    let intent = await visiblePayment(this.deps, input.paymentId);
    if (!intent.providerTransactionId) intent = await this.sync.startCheckout(intent);
    await settle(intent.providerTransactionId!, outcome);
    return (await this.sync.refresh(intent)).intent;
  }
}

/**
 * Tâche planifiée : paiements en attente relus chez le prestataire (notification perdue), puis
 * expirés au-delà de leur délai ; paiements non aboutis relus pendant la fenêtre de réussite tardive
 * (24 heures par défaut) : une réussite confirmée les passe à `succeeded` et publie l'événement.
 * Un montant approuvé différent n'expire jamais. Une erreur sur un paiement n'empêche pas l'examen
 * des suivants.
 */
export class ReconcilePendingPaymentsUseCase {
  private readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  /**
   * `pendingLimit` et `closedLimit` : quotas distincts par passage ; les paiements en attente sont
   * traités d'abord, les paiements clos (réussite tardive) sont relus moins souvent.
   */
  async execute(
    pendingLimit = 50,
    closedLimit = 50,
  ): Promise<{ examined: number; succeeded: number; failed: number; mismatched: number; errors: number }> {
    const now = this.deps.clock.now();
    const settings = this.deps.settings;
    const pending = await this.deps.payments.listPendingToReconcile({
      checkedBefore: new Date(now.getTime() - settings.recheckAfterSeconds * 1000),
      createdBefore: new Date(now.getTime() - MINUTE_MS),
      limit: pendingLimit,
    });
    const closed = await this.deps.payments.listClosedToReconcile({
      checkedBefore: new Date(now.getTime() - settings.lateSuccessRecheckMinutes * MINUTE_MS),
      lateSince: new Date(now.getTime() - settings.lateSuccessWindowHours * 3_600_000),
      limit: closedLimit,
    });
    const intents = [...pending, ...closed];
    const counts = { examined: intents.length, succeeded: 0, failed: 0, mismatched: 0, errors: 0 };
    for (const intent of intents) {
      try {
        let current = intent.providerTransactionId ? (await this.sync.refresh(intent)).intent : intent;
        if (current.status === 'pending') current = await this.sync.expire(current);
        if (current.status === intent.status) continue;
        if (current.status === 'succeeded') counts.succeeded += 1;
        else if (current.status === 'amount_mismatch') counts.mismatched += 1;
        else if (current.status !== 'pending') counts.failed += 1;
      } catch {
        counts.errors += 1;
      }
    }
    return counts;
  }
}
