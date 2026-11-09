import {
  INVOICE_STATUSES,
  balance,
  type Invoice,
  type InvoicePayment,
  type InvoiceStatus,
  paymentRefusal,
  withPayment,
} from '../domain/invoice';
import { beninMidnight } from '../domain/contract';
import { billingSettingsProblems, type BillingSettings } from '../domain/settings';
import { invoiceReference } from './issuing.use-cases';
import {
  type BillingDeps,
  type InvoiceFilter,
  type PageRequest,
  type PageResult,
  type StoredBillingSettings,
} from './ports';
import {
  BILLING_SETTINGS_ADMINS,
  BILLING_STAFF,
  currentCustomer,
  currentPayer,
  type CustomerScope,
  requireStaff,
} from './shared/access';
import { BillingErrors } from './shared/errors';
import {
  IDEMPOTENCY_KEY,
  oneOf,
  optionalDay,
  optionalText,
  optionalUuid,
  requireUuid,
} from './shared/validation';

function statusFilter(status: string): InvoiceStatus | undefined {
  return status ? oneOf('status', status, INVOICE_STATUSES) : undefined;
}

/** Factures visibles par le client : celles de son organisation active, ou les siennes en personnel. */
function customerFilter(scope: CustomerScope): InvoiceFilter {
  return scope.organizationId
    ? { organizationId: scope.organizationId }
    : { customerId: scope.userId, organizationId: null };
}

function isVisibleTo(invoice: Invoice, scope: CustomerScope): boolean {
  return scope.organizationId
    ? invoice.organizationId === scope.organizationId
    : invoice.customerId === scope.userId && invoice.organizationId === null;
}

/** « Mes factures » (espace KSP). */
export class ListMyInvoicesUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: { page: PageRequest; status: string }): Promise<PageResult<Invoice>> {
    const scope = currentCustomer();
    const status = statusFilter(input.status);
    return this.deps.invoices.list({ ...customerFilter(scope), ...(status ? { status } : {}) }, input.page);
  }
}

/** Détail d'une de mes factures ; hors périmètre : 404, sans révéler son existence. */
export class GetMyInvoiceUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(invoiceId: string): Promise<Invoice> {
    const scope = currentCustomer();
    const invoice = await this.deps.invoices.findById(requireUuid('invoiceId', invoiceId));
    if (!invoice || !isVisibleTo(invoice, scope)) throw BillingErrors.invoiceNotFound();
    return invoice;
  }
}

/**
 * Back-office : toutes les factures, filtrables. Période (`periodFrom`, `periodTo`, dates
 * AAAA-MM-JJ au Bénin, bornes incluses) : factures dont la période facturée touche au moins un jour
 * de l'intervalle.
 */
export class ListInvoicesUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: {
    page: PageRequest;
    status: string;
    customerId: string;
    organizationId: string;
    contractId: string;
    periodFrom?: string;
    periodTo?: string;
  }): Promise<PageResult<Invoice>> {
    requireStaff(BILLING_STAFF);
    const status = statusFilter(input.status);
    const fromDay = optionalDay('periodFrom', input.periodFrom);
    const toDay = optionalDay('periodTo', input.periodTo);
    if (fromDay !== undefined && toDay !== undefined && fromDay > toDay) {
      throw BillingErrors.invalid('periodTo', 'La fin de la période précède son début.');
    }
    const customerId = optionalUuid('customerId', input.customerId);
    const organizationId = optionalUuid('organizationId', input.organizationId);
    const contractId = optionalUuid('contractId', input.contractId);
    return this.deps.invoices.list(
      {
        ...(status ? { status } : {}),
        ...(customerId ? { customerId } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(contractId ? { contractId } : {}),
        ...(fromDay !== undefined ? { periodFrom: beninMidnight(fromDay) } : {}),
        // Borne de fin incluse : jusqu'à minuit du lendemain.
        ...(toDay !== undefined ? { periodTo: beninMidnight(toDay + 1) } : {}),
      },
      input.page,
    );
  }
}

export class GetInvoiceUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(invoiceId: string): Promise<Invoice> {
    requireStaff(BILLING_STAFF);
    const invoice = await this.deps.invoices.findById(requireUuid('invoiceId', invoiceId));
    if (!invoice) throw BillingErrors.invoiceNotFound();
    return invoice;
  }
}

/**
 * Paiement reçu hors ligne, enregistré au back-office. Paiement partiel accepté, jamais au-delà
 * du reste dû ; la facture devient « payée » au total (billing.invoice.paid).
 *
 * Idempotent par clé (en-tête Idempotency-Key, facultatif ; comme le paiement manuel du
 * Nettoyage) : un second envoi avec la même clé pour la même facture la renvoie telle quelle, sans
 * second paiement ni nouveau contrôle. Deux envois simultanés : le contrôle de version (et l'unicité
 * facture + clé en base) n'en laisse passer qu'un, l'autre relit la facture et rejoue.
 */
export class RecordInvoicePaymentUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: {
    invoiceId: string;
    amount: number;
    method: string;
    reference: string;
    idempotencyKey?: string;
  }): Promise<Invoice> {
    const staff = requireStaff(BILLING_STAFF);
    const key = input.idempotencyKey ?? '';
    if (key && !IDEMPOTENCY_KEY.test(key)) {
      throw BillingErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const invoice = await this.deps.invoices.findById(requireUuid('invoiceId', input.invoiceId));
    if (!invoice) throw BillingErrors.invoiceNotFound();
    if (key && hasPaymentKey(invoice, key)) return invoice;
    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      throw BillingErrors.invalidTransition(invoice.status, 'paid');
    }
    const refusal = paymentRefusal(invoice, input.amount, input.method);
    if (refusal) throw BillingErrors.paymentInvalid(refusal);
    const now = this.deps.clock.now();
    const payment = {
      id: this.deps.ids.next(),
      amount: input.amount,
      method: input.method as Invoice['payments'][number]['method'],
      reference: optionalText('reference', input.reference, 100),
      recordedBy: staff.userId,
      recordedAt: now,
      idempotencyKey: key || null,
    };
    const updated = withPayment(invoice, payment);
    let saved: boolean;
    try {
      saved = await this.deps.invoices.recordPayment(updated, payment, (overdueCount) =>
        updated.status === 'paid'
          ? [
              {
                type: 'billing.invoice.paid',
                payload: { ...invoiceReference(updated), paidAt: now.toISOString(), overdueCount },
              },
            ]
          : [],
      );
    } catch (error) {
      // Unicité facture + clé : un envoi concurrent avec la même clé vient d'être enregistré.
      const replayed = key ? await this.replay(invoice.id, key) : null;
      if (replayed) return replayed;
      throw error;
    }
    if (!saved) {
      const replayed = key ? await this.replay(invoice.id, key) : null;
      if (replayed) return replayed;
      throw BillingErrors.concurrentUpdate();
    }
    return { ...updated, version: updated.version + 1 };
  }

  /** Facture relue après une écriture concurrente : rejouée si le paiement de cette clé y figure. */
  private async replay(invoiceId: string, key: string): Promise<Invoice | null> {
    const current = await this.deps.invoices.findById(invoiceId);
    return current && hasPaymentKey(current, key) ? current : null;
  }
}

function hasPaymentKey(invoice: Invoice, key: string): boolean {
  return invoice.payments.some((payment) => payment.idempotencyKey === key);
}

const MAX_ATTEMPTS = 3;
const isClosed = (invoice: Invoice) => invoice.status === 'paid' || invoice.status === 'cancelled';

/**
 * « Mes factures » : reste dû payé depuis le portefeuille prépayé (ADR-046) — celui de
 * l'organisation de la facture (membre org_admin ou org_member dans son contexte), sinon celui du
 * client. Le reste dû est débité en entier par wallet, puis enregistré comme un paiement (moyen
 * `wallet`, reference = débit, auteur = le membre) : la facture devient payée
 * (billing.invoice.paid), ce qui lève une suspension selon les règles en place. Solde insuffisant :
 * WALLET_INSUFFICIENT_FUNDS (montant manquant), rien n'est débité ni enregistré.
 *
 * Idempotent par la clé du client (un seul débit, un seul paiement ; après une panne, la même clé
 * reprend le débit). Facture réglée ou annulée entre-temps : le débit est remboursé aussitôt.
 */
export class PayMyInvoiceFromWalletUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: { invoiceId: string; idempotencyKey: string }): Promise<Invoice> {
    const scope = currentPayer();
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw BillingErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const key = `wallet-${input.idempotencyKey}`;
    let invoice = await this.visible(requireUuid('invoiceId', input.invoiceId), scope);
    if (hasPaymentKey(invoice, key)) return invoice;
    if (isClosed(invoice)) throw BillingErrors.invalidTransition(invoice.status, 'paid');

    const debit = await this.deps.wallet.debit({
      idempotencyKey: `${invoice.id}:${input.idempotencyKey}`,
      holder: invoice.organizationId
        ? { type: 'organization', id: invoice.organizationId }
        : { type: 'user', id: invoice.customerId },
      amount: balance(invoice),
      object: { objectType: 'billing_invoice', objectId: invoice.id, part: '' },
      description: `Facture ${invoice.number}`,
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        invoice = await this.visible(invoice.id, scope);
        if (hasPaymentKey(invoice, key)) return invoice;
      }
      if (isClosed(invoice) || debit.amount > balance(invoice)) break;
      const now = this.deps.clock.now();
      const payment: InvoicePayment = {
        id: this.deps.ids.next(),
        amount: debit.amount,
        method: 'wallet',
        reference: debit.transactionId,
        recordedBy: scope.userId,
        recordedAt: now,
        idempotencyKey: key,
      };
      const updated = withPayment(invoice, payment);
      let saved = false;
      try {
        saved = await this.deps.invoices.recordPayment(updated, payment, (overdueCount) =>
          updated.status === 'paid'
            ? [
                {
                  type: 'billing.invoice.paid',
                  payload: { ...invoiceReference(updated), paidAt: now.toISOString(), overdueCount },
                },
              ]
            : [],
        );
      } catch {
        // Unicité facture + clé : un envoi concurrent de la même clé vient d'être enregistré.
        saved = false;
      }
      if (saved) return { ...updated, version: updated.version + 1 };
    }
    // Modifiée sans cesse en même temps : la même clé reprendra ce débit.
    if (!isClosed(invoice) && debit.amount <= balance(invoice)) throw BillingErrors.concurrentUpdate();
    await this.deps.wallet.refund({ transactionId: debit.transactionId, reason: 'paiement non enregistré' });
    throw BillingErrors.invalidTransition(invoice.status, 'paid');
  }

  private async visible(invoiceId: string, scope: CustomerScope): Promise<Invoice> {
    const invoice = await this.deps.invoices.findById(invoiceId);
    if (!invoice || !isVisibleTo(invoice, scope)) throw BillingErrors.invoiceNotFound();
    return invoice;
  }
}

export class GetBillingSettingsUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(): Promise<StoredBillingSettings> {
    requireStaff(BILLING_SETTINGS_ADMINS);
    return this.deps.settings.get();
  }
}

/** Délai de règlement (10 jours par défaut) : s'applique aux factures émises ensuite. */
export class UpdateBillingSettingsUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(settings: BillingSettings): Promise<StoredBillingSettings> {
    const staff = requireStaff(BILLING_SETTINGS_ADMINS);
    const problems = billingSettingsProblems(settings);
    if (problems.length) throw BillingErrors.invalid(`settings.${problems[0]}`);
    return this.deps.settings.save(settings, staff.userId, this.deps.clock.now());
  }
}
