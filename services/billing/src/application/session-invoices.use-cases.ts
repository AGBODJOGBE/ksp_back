import { createHash } from 'node:crypto';
import { currentContext } from '@ksp/platform';
import { beninDay, beninMidnight } from '../domain/contract';
import {
  type Invoice,
  type InvoiceLine,
  type InvoiceOrganization,
  type InvoicePayment,
} from '../domain/invoice';
import {
  INVOICE_LINE_KINDS,
  type InvoiceIssuance,
  type InvoiceSourceObject,
  paidInvoiceYear,
} from '../domain/issued-invoice';
import { SYSTEM_ACTOR } from './online-payments.use-cases';
import { type BillingDeps, type OutboxMessage } from './ports';
import { requireCaller } from './shared/access';
import { BillingErrors } from './shared/errors';
import { oneOf, optionalDay, optionalText, optionalUuid, requireUuid } from './shared/validation';

/** Seul cleaning émet les factures de séance et les reçus des frais de visite (partie 15.4). */
export const ISSUER_CALLERS = ['cleaning'] as const;

/** Clé d'émission : 8 à 150 caractères, lettres, chiffres, « : », « _ » et « - » (billing.proto). */
const ISSUE_KEY = /^[A-Za-z0-9:_-]{8,150}$/;
const MAX_LINES = 50;
const SESSION_RANK = /^(\d{1,4})\/(\d{1,4})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type IssuedKind = 'session' | 'visit_fee';
const ISSUED_KINDS: readonly IssuedKind[] = ['session', 'visit_fee'];
/** Objet facturé attendu pour chaque nature (clés "cleaning_session:…", "cleaning_request:…"). */
const SOURCE_OBJECT_TYPE: Record<IssuedKind, string> = {
  session: 'cleaning_session',
  visit_fee: 'cleaning_request',
};

interface MoneyInput {
  amount: number;
  currency: string;
}

/** Requête InvoiceIssuanceService.IssueInvoice, telle que le contrat la décrit (billing.proto). */
export interface IssueInvoiceInput {
  idempotencyKey: string;
  kind: string;
  customerId: string;
  organizationId: string;
  sourceObject?: { objectType: string; objectId: string } | undefined;
  requestNumber: string;
  programNumber: string;
  sessionRank: string;
  placeLabel: string;
  serviceDate: string;
  lines: {
    label: string;
    quantity: number;
    unitPrice?: MoneyInput | undefined;
    amount?: MoneyInput | undefined;
    kind?: string | undefined;
    serviceDate?: string | undefined;
    programNumber?: string | undefined;
    placeLabel?: string | undefined;
    sourceObjectId?: string | undefined;
  }[];
  payment?:
    { method: string; reference: string; amount?: MoneyInput | undefined; paidAt: string } | undefined;
}

/**
 * InvoiceIssuanceService.IssueInvoice (CDC Nettoyage v2, R-PP-06 et R-FV-04 ; ADR-055 décisions 4
 * et 9) : facture de séance d'un particulier ou reçu des frais de visite (particulier ou
 * entreprise), émis par cleaning une fois le portefeuille débité. La facture naît « payée » :
 * échéance = émission, paiement `wallet` (référence = débit du portefeuille, auteur « system ») ;
 * total = somme des lignes, positif ou nul, égal au montant payé ; seule une ligne
 * `visit_fee_deduction` est négative. Numéro FAC-<année du paiement au Bénin>-<n>, sans trou.
 * billing.invoice.issued est écrit dans l'outbox de la même transaction.
 *
 * Une séance d'entreprise n'a pas de facture propre : elle part sur la facture mensuelle de
 * l'organisation (R-PE-01) ; seuls ses frais de visite ont un reçu, avec l'en-tête lu dans identity.
 *
 * Idempotent par (appelant, clé) : cleaning rejoue l'appel tant qu'il n'est pas confirmé ; le même
 * contenu (même empreinte) rend la même facture (`created: false`), un autre contenu est refusé
 * (BILLING_IDEMPOTENCY_KEY_REUSED). L'émission (objet facturé, références, clé, empreinte) est
 * enregistrée à côté de la facture (invoice_issuances), dans la même transaction.
 */
export class IssueInvoiceUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: IssueInvoiceInput): Promise<{ invoice: Invoice; created: boolean }> {
    requireCaller(ISSUER_CALLERS);
    // Sans vérificateur de jeton (développement local), l'appelant n'est pas connu : seul cleaning
    // appelle cette méthode.
    const issuer = currentContext()?.callerService ?? 'cleaning';
    const draft = this.draft(input, issuer, this.deps.clock.now());
    const replay = (existing: Invoice) => {
      if (existing.issuance?.fingerprint !== draft.issuance.fingerprint) {
        throw BillingErrors.idempotencyKeyReused();
      }
      return { invoice: existing, created: false };
    };

    const existing = await this.deps.invoices.findByIssueKey(issuer, draft.issuance.idempotencyKey);
    if (existing) return replay(existing);

    const organization = draft.organizationId ? await this.organizationHeader(draft.organizationId) : null;
    const result = await this.deps.invoices.issuePaid(
      { ...draft, organization },
      paidInvoiceYear(draft),
      (invoice) => [issuedEvent(invoice, draft.issuance)],
    );
    // Émise entre-temps par un appel simultané avec la même clé.
    return result.created ? result : replay(result.invoice);
  }

  /**
   * En-tête de l'organisation (reçu des frais de visite d'une entreprise), copié d'identity à
   * l'émission. identity indisponible : erreur, cleaning rejoue l'appel ; organisation introuvable :
   * reçu émis sans en-tête (l'argent est déjà débité).
   */
  private async organizationHeader(organizationId: string): Promise<InvoiceOrganization | null> {
    const [profile] = await this.deps.organizations.findByIds([organizationId]);
    if (!profile) return null;
    const { legalName, address, ifu, rccm } = profile;
    return { legalName, address, ifu, rccm };
  }

  /** Requête validée, convertie en facture à enregistrer (sans numéro ni en-tête) et son émission. */
  private draft(input: IssueInvoiceInput, issuer: string, now: Date): IssuedDraft {
    if (!ISSUE_KEY.test(input.idempotencyKey)) {
      throw BillingErrors.invalid(
        'idempotencyKey',
        'Clé d’idempotence invalide (8 à 150 caractères : lettres, chiffres, « : », « _ » et « - »).',
      );
    }
    const kind = oneOf('kind', input.kind, ISSUED_KINDS);
    const customerId = requireUuid('customerId', input.customerId);
    const organizationId = optionalUuid('organizationId', input.organizationId) ?? null;
    if (organizationId && kind === 'session') {
      throw BillingErrors.invalid(
        'organizationId',
        'La séance d’une entreprise est facturée sur la facture mensuelle de l’organisation.',
      );
    }
    const sourceObject = parseSourceObject(kind, input.sourceObject);
    const session = kind === 'session' ? parseSessionFields(input) : rejectSessionFields(input);
    const lines = parseLines(input.lines);
    const total = lines.reduce((sum, line) => sum + line.amount, 0);
    if (total < 0) throw BillingErrors.invalid('lines', 'Le total de la facture ne peut pas être négatif.');
    const paid = parsePayment(input.payment, total);
    const paidAt = paid.paidAt ?? now;
    // Période : le jour de la séance, ou le jour du paiement des frais de visite (heure du Bénin).
    const day = session.serviceDay ?? beninDay(paidAt);
    const payments: InvoicePayment[] =
      total > 0
        ? [
            {
              id: this.deps.ids.next(),
              amount: total,
              method: 'wallet',
              reference: paid.reference,
              recordedBy: SYSTEM_ACTOR,
              recordedAt: paidAt,
              idempotencyKey: null,
            },
          ]
        : [];
    const references = {
      sourceObject,
      requestNumber: optionalText('requestNumber', input.requestNumber, 40),
      programNumber: optionalText('programNumber', input.programNumber, 40),
      sessionRank: session.sessionRank,
      placeLabel: optionalText('placeLabel', input.placeLabel, 120),
      serviceDate: session.serviceDate,
    };
    const fingerprint = contentFingerprint({
      kind,
      customerId,
      organizationId,
      ...references,
      lines,
      payment: { method: 'wallet', amount: total, reference: paid.reference, paidAt: paid.paidAt },
    });
    return {
      id: this.deps.ids.next(),
      status: 'paid',
      contractId: null,
      customerId,
      organizationId,
      source: 'cleaning',
      periodIndex: null,
      periodStart: beninMidnight(day),
      periodEnd: beninMidnight(day + 1),
      lines,
      total,
      issuedAt: now,
      dueAt: now,
      paidAt,
      payments,
      organization: null,
      version: 0,
      kind,
      issuance: { issuer, idempotencyKey: input.idempotencyKey, fingerprint, ...references, createdAt: now },
    };
  }
}

type IssuedDraft = Omit<Invoice, 'number'> & { kind: IssuedKind; issuance: InvoiceIssuance };

/**
 * billing.invoice.issued (version 1 du contrat de ce dépôt) : facture payée, échéance = émission ;
 * sans contrat, `contractId` porte l'objet facturé (séance ou demande). À la fusion avec le lot F,
 * une facture v2 publie la version 2 de l'événement, sans contrat : remplacer par son issuedEvent.
 */
function issuedEvent(invoice: Invoice, issuance: InvoiceIssuance): OutboxMessage {
  return {
    type: 'billing.invoice.issued',
    payload: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      customerId: invoice.customerId,
      organizationId: invoice.organizationId,
      source: invoice.source,
      contractId: issuance.sourceObject.objectId,
      total: { amount: invoice.total, currency: 'XOF' },
      periodStart: invoice.periodStart.toISOString(),
      periodEnd: invoice.periodEnd.toISOString(),
      issuedAt: invoice.issuedAt.toISOString(),
      dueAt: invoice.dueAt.toISOString(),
      ...(invoice.kind ? { kind: invoice.kind } : {}),
      status: 'paid',
    },
  };
}

/**
 * Empreinte SHA-256 du contenu validé (hors émetteur et clé) : valeurs normalisées dans un ordre
 * fixe, pour distinguer un rejeu d'une clé réutilisée pour un autre contenu.
 */
function contentFingerprint(content: {
  kind: IssuedKind;
  customerId: string;
  organizationId: string | null;
  sourceObject: InvoiceSourceObject;
  requestNumber: string | null;
  programNumber: string | null;
  sessionRank: string | null;
  placeLabel: string | null;
  serviceDate: string | null;
  lines: InvoiceLine[];
  payment: { method: string; amount: number; reference: string | null; paidAt: Date | null };
}): string {
  const canonical = [
    content.kind,
    content.customerId,
    content.organizationId,
    content.sourceObject.objectType,
    content.sourceObject.objectId,
    content.requestNumber,
    content.programNumber,
    content.sessionRank,
    content.placeLabel,
    content.serviceDate,
    content.lines.map((line) => [
      line.label,
      line.quantity,
      line.unitPrice,
      line.amount,
      line.kind ?? null,
      line.serviceDate ?? null,
      line.programNumber ?? null,
      line.placeLabel ?? null,
      line.sourceObjectId ?? null,
    ]),
    content.payment.method,
    content.payment.amount,
    content.payment.reference,
    content.payment.paidAt?.toISOString() ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parseSourceObject(
  kind: IssuedKind,
  sourceObject: IssueInvoiceInput['sourceObject'],
): InvoiceSourceObject {
  if (!sourceObject) throw BillingErrors.invalid('sourceObject', 'Objet facturé manquant.');
  if (sourceObject.objectType !== SOURCE_OBJECT_TYPE[kind]) {
    throw BillingErrors.invalid('sourceObject.objectType', `Objet attendu : ${SOURCE_OBJECT_TYPE[kind]}.`);
  }
  return {
    objectType: sourceObject.objectType,
    objectId: requireUuid('sourceObject.objectId', sourceObject.objectId),
  };
}

/** Séance : rang « 3/15 » et date de la séance obligatoires. */
function parseSessionFields(input: IssueInvoiceInput) {
  const rank = SESSION_RANK.exec(input.sessionRank);
  if (!rank || Number(rank[1]) < 1 || Number(rank[1]) > Number(rank[2])) {
    throw BillingErrors.invalid('sessionRank', 'Rang de la séance attendu sous la forme « 3/15 ».');
  }
  const serviceDay = optionalDay('serviceDate', input.serviceDate);
  if (serviceDay === undefined) throw BillingErrors.invalid('serviceDate', 'Date de la séance manquante.');
  return { sessionRank: `${Number(rank[1])}/${Number(rank[2])}`, serviceDate: input.serviceDate, serviceDay };
}

/** Frais de visite : ni rang ni date de séance. */
function rejectSessionFields(input: IssueInvoiceInput) {
  if (input.sessionRank) throw BillingErrors.invalid('sessionRank', 'Sans objet pour des frais de visite.');
  if (input.serviceDate) throw BillingErrors.invalid('serviceDate', 'Sans objet pour des frais de visite.');
  return { sessionRank: null, serviceDate: null, serviceDay: undefined };
}

/** Montant entier en XOF (devise vide acceptée). */
function amountOf(field: string, money: MoneyInput | undefined): number {
  if (!money || !Number.isSafeInteger(money.amount) || (money.currency && money.currency !== 'XOF')) {
    throw BillingErrors.invalid(field, 'Montant entier en XOF attendu.');
  }
  return money.amount;
}

/** 1 à 50 lignes ; montant = quantité × prix unitaire ; seule une déduction est négative. */
function parseLines(lines: IssueInvoiceInput['lines']): InvoiceLine[] {
  if (lines.length < 1 || lines.length > MAX_LINES) {
    throw BillingErrors.invalid('lines', `1 à ${MAX_LINES} lignes.`);
  }
  return lines.map((line, index) => {
    const field = `lines[${index}]`;
    const label = optionalText(`${field}.label`, line.label, 200);
    if (!label) throw BillingErrors.invalid(`${field}.label`, 'Libellé manquant.');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw BillingErrors.invalid(`${field}.quantity`, 'Quantité entière positive attendue.');
    }
    const unitPrice = amountOf(`${field}.unitPrice`, line.unitPrice);
    const amount = amountOf(`${field}.amount`, line.amount);
    if (amount !== unitPrice * line.quantity) {
      throw BillingErrors.invalid(`${field}.amount`, 'Montant différent de la quantité × le prix unitaire.');
    }
    const kind = line.kind ? oneOf(`${field}.kind`, line.kind, INVOICE_LINE_KINDS) : undefined;
    // Déduction des frais de visite (R-FV-05) : la seule ligne négative, toujours négative.
    if ((kind === 'visit_fee_deduction') !== amount < 0) {
      throw BillingErrors.invalid(
        `${field}.amount`,
        'Seule une déduction des frais de visite est négative, et elle l’est toujours.',
      );
    }
    optionalDay(`${field}.serviceDate`, line.serviceDate);
    const serviceDate = line.serviceDate || undefined;
    const programNumber = optionalText(`${field}.programNumber`, line.programNumber, 40);
    const placeLabel = optionalText(`${field}.placeLabel`, line.placeLabel, 120);
    const sourceObjectId = optionalUuid(`${field}.sourceObjectId`, line.sourceObjectId);
    // Champs absents omis : la ligne v2 ne porte que ce que cleaning a envoyé.
    return {
      label,
      quantity: line.quantity,
      unitPrice,
      amount,
      ...(kind ? { kind } : {}),
      ...(serviceDate ? { serviceDate } : {}),
      ...(programNumber ? { programNumber } : {}),
      ...(placeLabel ? { placeLabel } : {}),
      ...(sourceObjectId ? { sourceObjectId } : {}),
    };
  });
}

/** Paiement par le portefeuille, égal au total ; référence = débit (facultative pour un total nul). */
function parsePayment(
  payment: IssueInvoiceInput['payment'],
  total: number,
): { reference: string | null; paidAt: Date | null } {
  if (!payment) throw BillingErrors.invalid('payment', 'Paiement manquant.');
  if (payment.method !== 'wallet') throw BillingErrors.invalid('payment.method', 'Moyen attendu : wallet.');
  if (amountOf('payment.amount', payment.amount) !== total) {
    throw BillingErrors.invalid('payment.amount', 'Le montant payé doit être égal au total de la facture.');
  }
  const reference =
    total > 0
      ? requireUuid('payment.reference', payment.reference)
      : optionalUuid('payment.reference', payment.reference);
  if (payment.paidAt && (!ISO_INSTANT.test(payment.paidAt) || Number.isNaN(Date.parse(payment.paidAt)))) {
    throw BillingErrors.invalid('payment.paidAt', 'Date ISO 8601 attendue.');
  }
  return { reference: reference ?? null, paidAt: payment.paidAt ? new Date(payment.paidAt) : null };
}
