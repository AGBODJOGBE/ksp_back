import {
  INVOICE_STATUSES,
  type Invoice,
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
  type CustomerScope,
  requireStaff,
} from './shared/access';
import { BillingErrors } from './shared/errors';
import { oneOf, optionalDay, optionalText, optionalUuid, requireUuid } from './shared/validation';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

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
