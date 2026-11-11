import {
  isCalendarDate,
  isLinkSubjectType,
  lastAttempt,
  LINK_MAX_LIFETIME_MS,
  LINK_MIN_LIFETIME_MS,
  LINK_TOKEN,
  type LinkStatus,
  linkStatus,
  MAX_AMOUNT,
  type PaymentLink,
  payRefusal,
  revoke,
  sameLinkRequest,
} from '../domain/payment-link';
import { type PaymentIntent } from '../domain/payment-intent';
import { type PaymentDeps } from './ports';
import { requireIssuer } from './shared/access';
import { PaymentErrors } from './shared/errors';
import {
  IDEMPOTENCY_KEY,
  oneOf,
  optionalText,
  requireInstant,
  requireText,
  requireUuid,
  requireXof,
} from './shared/validation';
import { PaymentSync } from './sync';

const HOUR_MS = 3_600_000;
/** Téléphone du payeur, facultatif : E.164. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Lien et ce qui en découle : statut, essais de paiement, jeton et adresse publique. */
export interface LinkView {
  link: PaymentLink;
  status: LinkStatus;
  /** Essais de paiement, les plus anciens d'abord. */
  attempts: PaymentIntent[];
  token: string;
  url: string;
}

/** Outils communs des cas d'usage des liens. */
class Links {
  readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  token(link: PaymentLink): string {
    return this.deps.linkTokens.issue(link.id);
  }

  url(token: string): string {
    return `${this.deps.settings.linkBaseUrl.replace(/\/+$/, '')}/${token}`;
  }

  async view(link: PaymentLink, attempts?: PaymentIntent[]): Promise<LinkView> {
    const list = attempts ?? (await this.deps.payments.listForLink(link.id));
    const token = this.token(link);
    return {
      link,
      status: linkStatus(link, list, this.deps.clock.now()),
      attempts: list,
      token,
      url: this.url(token),
    };
  }

  /** Lien d'un jeton reçu de la page publique ; jeton mal formé ou inconnu : 404. */
  async byToken(token: string): Promise<PaymentLink> {
    if (!LINK_TOKEN.test(token)) throw PaymentErrors.linkNotFound();
    const link = await this.deps.links.findByTokenHash(this.deps.linkTokens.hash(token));
    if (!link) throw PaymentErrors.linkNotFound();
    return link;
  }

  /** Lien de l'émetteur appelant ; celui d'un autre émetteur reste introuvable. */
  async ofIssuer(issuer: string, linkId: string): Promise<PaymentLink> {
    const link = await this.deps.links.findById(requireUuid('linkId', linkId));
    if (!link || link.issuer !== issuer) throw PaymentErrors.linkNotFound();
    return link;
  }

  /** Essai en attente sans page (prestataire en panne au premier essai) : nouvel essai, retour au lien. */
  withCheckout(intent: PaymentIntent, token: string): Promise<PaymentIntent> | PaymentIntent {
    if (intent.status !== 'pending' || intent.checkoutUrl) return intent;
    if (intent.expiresAt <= this.deps.clock.now()) return this.sync.expire(intent);
    return this.sync.startCheckout(intent, this.url(token));
  }

  /** Remplace un essai dans la liste (après une mise à jour). */
  static replace(attempts: PaymentIntent[], intent: PaymentIntent): PaymentIntent[] {
    return attempts.map((attempt) => (attempt.id === intent.id ? intent : attempt));
  }
}

/**
 * Création d'un lien de paiement par un service émetteur (ADR-040). Idempotente par (émetteur, clé) :
 * le rejeu rend le même lien et le même jeton. Refusée si l'objet est déjà payé, ou si un lien encore
 * payable (ou en vérification) existe pour lui : l'émetteur révoque l'ancien d'abord, pour qu'un seul
 * lien soit payable par objet.
 */
export class CreatePaymentLinkUseCase {
  private readonly links: Links;

  constructor(private readonly deps: PaymentDeps) {
    this.links = new Links(deps);
  }

  async execute(input: {
    idempotencyKey: string;
    subjectType: string;
    subjectId: string;
    reference: string;
    beneficiaryName: string;
    description: string;
    amount: { amount: number; currency: string } | undefined;
    dueDate: string;
    expiresAt: string;
    payerName: string;
    payerPhone: string;
  }): Promise<{ view: LinkView; created: boolean }> {
    const issuer = requireIssuer(this.deps.settings.linkIssuers);
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw PaymentErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    if (!isLinkSubjectType(input.subjectType)) {
      throw PaymentErrors.invalid(
        'subjectType',
        'Type d’objet invalide (minuscules, chiffres et « _ », 3 à 50 caractères ; types du paiement par compte réservés).',
      );
    }
    const now = this.deps.clock.now();
    const request = {
      subjectType: input.subjectType,
      subjectId: requireUuid('subjectId', input.subjectId),
      amount: requireXof('amount', input.amount, MAX_AMOUNT),
    };
    const reference = requireText('reference', input.reference, 60);
    const beneficiaryName = requireText('beneficiaryName', input.beneficiaryName, 120);
    const description = requireText('description', input.description, 140);
    const dueDate = input.dueDate ? input.dueDate : null;
    if (dueDate !== null && !isCalendarDate(dueDate)) {
      throw PaymentErrors.invalid('dueDate', 'Date attendue au format AAAA-MM-JJ.');
    }
    const expiresAt = requireInstant('expiresAt', input.expiresAt);
    const lifetime = expiresAt.getTime() - now.getTime();
    if (lifetime < LINK_MIN_LIFETIME_MS || lifetime > LINK_MAX_LIFETIME_MS) {
      throw PaymentErrors.invalid('expiresAt', 'Expiration attendue entre 1 heure et 180 jours.');
    }
    const payerName = optionalText('payerName', input.payerName, 120);
    const payerPhone = input.payerPhone ? input.payerPhone : null;
    if (payerPhone !== null && !E164.test(payerPhone)) {
      throw PaymentErrors.invalid('payerPhone', 'Numéro au format international attendu (+229…).');
    }

    const replay = await this.deps.links.findByIssuerKey(issuer, input.idempotencyKey);
    if (replay) {
      if (!sameLinkRequest(replay, request)) throw PaymentErrors.keyReused();
      return { view: await this.links.view(replay), created: false };
    }

    const [existing, succeeded] = await Promise.all([
      this.deps.links.listForSubject(request.subjectType, request.subjectId),
      this.deps.payments.listSucceeded({ subjectType: request.subjectType, subjectId: request.subjectId }),
    ]);
    if (succeeded.length > 0) throw PaymentErrors.linkAlreadyPaid();
    for (const other of existing) {
      const status = (await this.links.view(other)).status;
      if (status === 'paid') throw PaymentErrors.linkAlreadyPaid();
      if (status === 'active' || status === 'under_review') throw PaymentErrors.linkAlreadyActive();
    }

    const draft: PaymentLink = {
      id: this.deps.ids.next(),
      issuer,
      idempotencyKey: input.idempotencyKey,
      ...request,
      reference,
      beneficiaryName,
      description,
      dueDate,
      payerName,
      payerPhone,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    const tokenHash = this.deps.linkTokens.hash(this.deps.linkTokens.issue(draft.id));
    const stored = await this.deps.links.create(draft, tokenHash);
    if (!stored.created && !sameLinkRequest(stored.link, request)) throw PaymentErrors.keyReused();
    return { view: await this.links.view(stored.link), created: stored.created };
  }
}

/** Lien vu par son émetteur (statut, essais, adresse à renvoyer au payeur). */
export class GetPaymentLinkUseCase {
  private readonly links: Links;

  constructor(private readonly deps: PaymentDeps) {
    this.links = new Links(deps);
  }

  async execute(linkId: string): Promise<LinkView> {
    const issuer = requireIssuer(this.deps.settings.linkIssuers);
    return this.links.view(await this.links.ofIssuer(issuer, linkId));
  }
}

/**
 * Révocation par l'émetteur (dossier soldé autrement, montant à corriger…) : le lien ne peut plus être
 * payé, et un essai en attente est annulé (page annulée chez le prestataire quand son API le permet).
 * Une réussite tardive reste enregistrée (`payment.link.paid`) : l'argent reçu n'est jamais ignoré.
 * Rejouable sans effet ; refusée pour un lien déjà payé.
 */
export class RevokePaymentLinkUseCase {
  private readonly links: Links;

  constructor(private readonly deps: PaymentDeps) {
    this.links = new Links(deps);
  }

  async execute(input: { linkId: string; reason: string }): Promise<LinkView> {
    const issuer = requireIssuer(this.deps.settings.linkIssuers);
    const reason = optionalText('reason', input.reason, 200);
    let link = await this.links.ofIssuer(issuer, input.linkId);
    let attempts = await this.deps.payments.listForLink(link.id);
    const outcome = revoke(link, linkStatus(link, attempts, this.deps.clock.now()), {
      reason,
      now: this.deps.clock.now(),
    });
    if (outcome.kind === 'refused') throw PaymentErrors.linkAlreadyPaid();
    if (outcome.kind === 'revoked') {
      if (!(await this.deps.links.save(outcome.link))) throw PaymentErrors.concurrentUpdate();
      link = { ...outcome.link, version: outcome.link.version + 1 };
    }
    for (const attempt of attempts.filter((a) => a.status === 'pending')) {
      attempts = Links.replace(attempts, await this.links.sync.supersede(attempt));
    }
    return this.links.view(link, attempts);
  }
}

/**
 * Page publique d'un lien : résumé sans donnée personnelle. Le dernier essai encore en attente est
 * vérifié auprès du prestataire au passage (au plus une fois par intervalle) et expiré au-delà de son
 * délai ; s'il ne répond pas, le dernier statut connu est rendu.
 */
export class GetPublicPaymentLinkUseCase {
  private readonly links: Links;

  constructor(private readonly deps: PaymentDeps) {
    this.links = new Links(deps);
  }

  async execute(token: string): Promise<LinkView> {
    const link = await this.links.byToken(token);
    let attempts = await this.deps.payments.listForLink(link.id);
    const last = lastAttempt(attempts);
    if (last?.status === 'pending') attempts = Links.replace(attempts, await this.check(last));
    return this.links.view(link, attempts);
  }

  private async check(intent: PaymentIntent): Promise<PaymentIntent> {
    const now = this.deps.clock.now().getTime();
    const recheckMs = this.deps.settings.recheckAfterSeconds * 1000;
    let current = intent;
    try {
      const due = !intent.lastCheckedAt || now - intent.lastCheckedAt.getTime() >= recheckMs;
      if (intent.providerTransactionId && due) current = (await this.links.sync.refresh(intent)).intent;
      if (current.status === 'pending') current = await this.links.sync.expire(current);
    } catch {
      // Prestataire injoignable : la notification ou le rapprochement prendront le relais.
    }
    return current;
  }
}

/**
 * Paiement d'un lien par le payeur (route publique) : idempotent par (lien, clé) ; un essai encore en
 * attente est réutilisé (une seule page payable par lien). Refusé si l'objet est déjà payé (par ce
 * lien ou un autre), si un essai est en écart de montant non traité (ADR-032), si le lien est révoqué
 * ou expiré, et au-delà de `linkAttemptsPerHour` essais par heure. Le rejeu d'une même clé passe avant
 * ces contrôles.
 */
export class PayPaymentLinkUseCase {
  private readonly links: Links;

  constructor(private readonly deps: PaymentDeps) {
    this.links = new Links(deps);
  }

  async execute(input: {
    token: string;
    idempotencyKey: string;
  }): Promise<{ payment: PaymentIntent; created: boolean }> {
    const link = await this.links.byToken(input.token);
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw PaymentErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const replay = await this.deps.payments.findByLinkKey(link.id, input.idempotencyKey);
    if (replay) return { payment: await this.links.withCheckout(replay, input.token), created: false };

    const subject = { subjectType: link.subjectType, subjectId: link.subjectId };
    const [attempts, succeeded, underReview] = await Promise.all([
      this.deps.payments.listForLink(link.id),
      this.deps.payments.listSucceeded(subject),
      this.deps.payments.listUnresolvedMismatches(subject),
    ]);
    if (succeeded.length > 0) throw PaymentErrors.linkAlreadyPaid();
    if (underReview.length > 0) {
      this.deps.alerts.paymentUnderReview({ ...subject, paymentIds: underReview });
      throw PaymentErrors.underReview();
    }
    const now = this.deps.clock.now();
    const refusal = payRefusal(linkStatus(link, attempts, now));
    if (refusal === 'revoked') throw PaymentErrors.linkRevoked();
    if (refusal === 'expired') throw PaymentErrors.linkExpired();
    if (refusal) throw PaymentErrors.linkAlreadyPaid();

    // Essai encore en attente : réutilisé tant que sa page peut être payée (une seule par lien).
    const open = lastAttempt(attempts.filter((a) => a.status === 'pending'));
    if (open) {
      const current = await this.links.sync.expire(open);
      if (current.status === 'pending') {
        return { payment: await this.links.withCheckout(current, input.token), created: false };
      }
    }
    const recent = attempts.filter((a) => now.getTime() - a.createdAt.getTime() < HOUR_MS).length;
    if (recent >= this.deps.settings.linkAttemptsPerHour) throw PaymentErrors.linkTooManyAttempts();

    const draft: PaymentIntent = {
      id: this.deps.ids.next(),
      subject: { type: link.subjectType, id: link.subjectId, part: null, reference: link.reference },
      amount: link.amount,
      customerId: null,
      organizationId: null,
      paymentLinkId: link.id,
      status: 'pending',
      provider: this.deps.provider.name,
      providerTransactionId: null,
      providerReference: null,
      checkoutUrl: null,
      idempotencyKey: input.idempotencyKey,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: this.links.sync.expiry(now),
      completedAt: null,
      lastCheckedAt: null,
      mismatchResolution: null,
      receivedAmount: null,
      version: 0,
    };
    const stored = await this.deps.payments.create(draft);
    return { payment: await this.links.withCheckout(stored.intent, input.token), created: stored.created };
  }
}

/**
 * Développement seulement : joue la page de paiement du prestataire simulé pour le dernier essai en
 * attente du lien, puis le confirme par le même chemin qu'une notification.
 */
export class SimulatePaymentLinkPaymentUseCase {
  private readonly links: Links;

  constructor(private readonly deps: PaymentDeps) {
    this.links = new Links(deps);
  }

  async execute(input: { token: string; outcome: string }): Promise<PaymentIntent> {
    const settle = this.deps.provider.settle?.bind(this.deps.provider);
    if (!this.deps.settings.simulationEnabled || !settle) throw PaymentErrors.simulationDisabled();
    const outcome = oneOf<'succeeded' | 'failed'>('outcome', input.outcome, ['succeeded', 'failed']);
    const link = await this.links.byToken(input.token);
    const pending = lastAttempt(
      (await this.deps.payments.listForLink(link.id)).filter((a) => a.status === 'pending'),
    );
    if (!pending) throw PaymentErrors.notFound();
    const intent = pending.providerTransactionId
      ? pending
      : await this.links.sync.startCheckout(pending, this.links.url(input.token));
    await settle(intent.providerTransactionId!, outcome);
    return (await this.links.sync.refresh(intent)).intent;
  }
}
