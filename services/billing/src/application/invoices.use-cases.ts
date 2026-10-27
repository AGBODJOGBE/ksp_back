import {
  INVOICE_STATUSES,
  type Invoice,
  type InvoiceStatus,
  paymentRefusal,
  withPayment,
} from '../domain/invoice';
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
import { oneOf, optionalText, optionalUuid, requireUuid } from './shared/validation';

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

/** Back-office : toutes les factures, filtrables. */
export class ListInvoicesUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: {
    page: PageRequest;
    status: string;
    customerId: string;
    organizationId: string;
    contractId: string;
  }): Promise<PageResult<Invoice>> {
    requireStaff(BILLING_STAFF);
    const status = statusFilter(input.status);
    const customerId = optionalUuid('customerId', input.customerId);
    const organizationId = optionalUuid('organizationId', input.organizationId);
    const contractId = optionalUuid('contractId', input.contractId);
    return this.deps.invoices.list(
      {
        ...(status ? { status } : {}),
        ...(customerId ? { customerId } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(contractId ? { contractId } : {}),
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
 */
export class RecordInvoicePaymentUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: {
    invoiceId: string;
    amount: number;
    method: string;
    reference: string;
  }): Promise<Invoice> {
    const staff = requireStaff(BILLING_STAFF);
    const invoice = await this.deps.invoices.findById(requireUuid('invoiceId', input.invoiceId));
    if (!invoice) throw BillingErrors.invoiceNotFound();
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
    };
    const updated = withPayment(invoice, payment);
    const saved = await this.deps.invoices.recordPayment(updated, payment, (overdueCount) =>
      updated.status === 'paid'
        ? [
            {
              type: 'billing.invoice.paid',
              payload: { ...invoiceReference(updated), paidAt: now.toISOString(), overdueCount },
            },
          ]
        : [],
    );
    if (!saved) throw BillingErrors.concurrentUpdate();
    return { ...updated, version: updated.version + 1 };
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
