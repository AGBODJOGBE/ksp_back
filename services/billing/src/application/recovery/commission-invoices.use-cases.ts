import { type RecoveryEventPayloads, type WalletEventPayloads } from '@ksp/contracts';
import { AppError } from '@ksp/platform';
import {
  COMMISSION_DEBIT_OBJECT_TYPE,
  COMMISSION_INVOICE_STATUSES,
  commissionBalance,
  commissionDebitKey,
  type CommissionDebitFailure,
  type CommissionInvoice,
  type CommissionInvoiceStatus,
  type CreditorRef,
  draftCommissionInvoice,
  parsePeriod,
  periodLabel,
  withCommissionDebited,
  withCommissionDebitFailed,
} from '../../domain/commission-invoice';
import { type InvoiceOrganization } from '../../domain/invoice';
import { lastClosedMonth } from '../../domain/monthly-invoice';
import { formatAmount, type PendingObligation } from '../obligations.use-cases';
import { type OutboxMessage, type PageRequest, type PageResult } from '../ports';
import {
  currentCustomer,
  type CustomerScope,
  RECOVERY_BILLING_STAFF,
  requireCaller,
  requireStaff,
} from '../shared/access';
import { BillingErrors } from '../shared/errors';
import { oneOf, optionalUuid, requireUuid } from '../shared/validation';
import { type CommissionInvoiceFilter, type RecoveryBillingDeps, type RecoveryBillingOptions } from './ports';

/** Consommateur inscrit dans l'inbox pour les événements du recouvrement (ADR-064). */
export const RECOVERY_EVENTS_CONSUMER = 'billing.recovery';

/** Lots de 200 au plus par passage ; la suite au passage suivant. */
export const COMMISSION_BATCH_SIZE = 200;

/** Nouvel essai après un solde insuffisant : un jour par défaut (réglable). */
export const DEFAULT_DEBIT_RETRY_DELAY_MS = 24 * 3_600_000;

/** Wallet indisponible ou qui refuse pour une autre raison : nouvel essai un quart d'heure plus tard. */
export const WALLET_ERROR_RETRY_MS = 15 * 60_000;

const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

/** Événement d'émission : identifiants et montants seulement (ADR-064). */
export function commissionInvoiceIssuedEvent(invoice: CommissionInvoice): OutboxMessage {
  return {
    type: 'billing.commission_invoice.issued',
    payload: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      creditor: { type: invoice.creditor.type, id: invoice.creditor.id },
      period: periodLabel(invoice),
      totalCollected: xof(invoice.totals.collected),
      commissionDeducted: xof(invoice.totals.deducted),
      commissionInvoiced: xof(invoice.totals.invoiced),
      commissionTotal: xof(invoice.totals.total),
      issuedAt: invoice.issuedAt.toISOString(),
    },
  };
}

/**
 * Encaissement d'un dossier (`recovery.payment.collected`) : gardé comme ligne de la facture de
 * commission du mois de sa réception. Montants et mode de règlement viennent de l'événement :
 * billing ne recalcule pas la commission (règle figée dans le mandat, ADR-062).
 */
export class RecordCommissionCollectionUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(input: {
    eventId: string;
    payload: RecoveryEventPayloads['recovery.payment.collected'];
  }): Promise<'recorded' | 'duplicate'> {
    const { payload } = input;
    return this.deps.recovery.recordCollection(
      {
        collectionId: payload.collectionId.toLowerCase(),
        creditor: { type: payload.creditor.type, id: payload.creditor.id.toLowerCase() },
        caseId: payload.caseId.toLowerCase(),
        caseNumber: payload.caseNumber,
        source: payload.source,
        gross: payload.gross.amount,
        commission: payload.commission.amount,
        settlement: payload.commissionSettlement,
        receivedAt: new Date(payload.receivedAt),
        invoiceId: null,
      },
      { eventId: input.eventId, consumer: `${RECOVERY_EVENTS_CONSUMER}.recovery.payment.collected` },
    );
  }
}

/**
 * Tâche planifiée du 1er du mois (R-CO-05) : une facture de commission par créancier pour le dernier
 * mois terminé (heure du Bénin), avec ses encaissements non facturés. Idempotente : une seule facture
 * par créancier et par mois, même avec plusieurs passages ou répliques.
 *
 * En-tête d'une organisation créancière figé à l'émission, lu dans identity (comme les factures du
 * Nettoyage, ADR-028) : jamais de facture d'organisation sans en-tête. Les comptes sont facturés
 * d'abord ; identity indisponible → erreur après eux, les organisations au passage suivant ;
 * organisation introuvable → reportée (`deferredOrganizationIds`, alerte journalisée par la tâche).
 */
export class IssueCommissionInvoicesUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(): Promise<{ issued: number; deferredOrganizationIds: string[] }> {
    const now = this.deps.clock.now();
    const month = lastClosedMonth(now);
    const creditors = await this.deps.recovery.listCreditorsToInvoice(month, COMMISSION_BATCH_SIZE);
    let issued = 0;
    const issue = async (creditor: CreditorRef, organization: InvoiceOrganization | null) => {
      const invoice = await this.deps.recovery.issueCommissionInvoice(
        creditor,
        month,
        (collections) =>
          collections.length === 0
            ? null
            : draftCommissionInvoice({
                id: this.deps.ids.next(),
                creditor,
                month,
                collections,
                organization,
                now,
              }),
        (created) => [commissionInvoiceIssuedEvent(created)],
      );
      if (invoice) issued += 1;
    };

    for (const creditor of creditors.filter((each) => each.type === 'user')) await issue(creditor, null);
    const organizations = creditors.filter((each) => each.type === 'organization');
    const deferredOrganizationIds: string[] = [];
    if (organizations.length === 0) return { issued, deferredOrganizationIds };
    const headers = await this.headers(organizations.map((each) => each.id));
    for (const creditor of organizations) {
      const organization = headers.get(creditor.id.toLowerCase());
      if (organization) await issue(creditor, organization);
      else deferredOrganizationIds.push(creditor.id);
    }
    return { issued, deferredOrganizationIds };
  }

  private async headers(organizationIds: readonly string[]): Promise<Map<string, InvoiceOrganization>> {
    const profiles = await this.deps.organizations.findByIds(organizationIds);
    return new Map(
      profiles.map(({ id, legalName, address, ifu, rccm }) => [
        id.toLowerCase(),
        { legalName, address, ifu, rccm },
      ]),
    );
  }
}

/** Échec d'un débit : identifiants et code d'erreur seulement, pour le journal de la tâche. */
export interface CommissionDebitFailureReport {
  invoiceId: string;
  invoiceNumber: string;
  reason: CommissionDebitFailure;
  code: string;
}

/**
 * Débit automatique de la commission `invoiced` (décision du 2026-11-23) : du portefeuille prépayé du
 * créancier (wallet.Debit, ADR-046), objet `billing_commission_invoice`, clé stable par facture (un
 * débit déjà fait est rendu tel quel par wallet : rien n'est débité deux fois). Solde insuffisant : la
 * facture reste due, nouvel essai après le délai réglable (un jour par défaut), ou dès un crédit du
 * portefeuille (`RetryCommissionDebitsOnWalletCreditUseCase`) ; autre échec de wallet : nouvel essai
 * un quart d'heure plus tard. La finance suit les factures dues au back-office.
 */
export class DebitCommissionInvoicesUseCase {
  constructor(
    private readonly deps: RecoveryBillingDeps,
    private readonly options: RecoveryBillingOptions,
  ) {}

  async execute(): Promise<{ paid: number; failures: CommissionDebitFailureReport[] }> {
    const now = this.deps.clock.now();
    return debitInvoices(
      this.deps,
      this.options,
      await this.deps.recovery.listDueDebits(now, COMMISSION_BATCH_SIZE),
      now,
    );
  }
}

/**
 * Nouvel essai dès un crédit du portefeuille (`wallet.prepaid.credited` : recharge, remboursement,
 * crédit de la finance ou d'un service) : les factures de commission dues du titulaire crédité sont
 * débitées tout de suite, sans attendre l'essai suivant (un jour après un solde insuffisant). Même
 * débit que la tâche planifiée — clé stable par facture : wallet rend le débit déjà fait, jamais un
 * second — et même suite en cas d'échec. Sous le verrou de la tâche : jamais deux passages de débit
 * en même temps, d'une réplique à l'autre ; verrou pris (passage en cours) : erreur, l'événement
 * revient par la file de reprise. Aucune facture due : rien, sans prendre le verrou. Le même
 * événement reçu deux fois n'a pas d'effet de plus : une facture réglée n'est plus due.
 */
export class RetryCommissionDebitsOnWalletCreditUseCase {
  constructor(
    private readonly deps: RecoveryBillingDeps,
    private readonly options: RecoveryBillingOptions,
  ) {}

  async execute(input: {
    payload: Pick<WalletEventPayloads['wallet.prepaid.credited'], 'holder'>;
  }): Promise<{ due: number; paid: number; failures: CommissionDebitFailureReport[] }> {
    const creditor: CreditorRef = {
      type: input.payload.holder.type,
      id: input.payload.holder.id.toLowerCase(),
    };
    if ((await this.dueInvoices(creditor)).length === 0) return { due: 0, paid: 0, failures: [] };
    const run = await this.deps.debitLock.tryRun(async () => {
      // Relues sous le verrou : le passage qui le tenait a pu les régler.
      const invoices = await this.dueInvoices(creditor);
      const outcome = await debitInvoices(this.deps, this.options, invoices, this.deps.clock.now());
      return { due: invoices.length, ...outcome };
    });
    if (!run.ran) {
      throw new Error('Débit des commissions en cours ; nouvel essai après le crédit du portefeuille.');
    }
    return run.result;
  }

  private async dueInvoices(creditor: CreditorRef): Promise<CommissionInvoice[]> {
    const unpaid = await this.deps.recovery.listUnpaidForCreditors([creditor]);
    return unpaid.filter((invoice) => commissionBalance(invoice) > 0);
  }
}

/**
 * Un essai de débit par facture due, avec la clé stable de la facture : réglée, ou échec noté avec son
 * prochain essai (solde insuffisant : délai réglable ; autre échec de wallet : un quart d'heure).
 * Facture modifiée entre-temps (contrôle de version) : rien n'est écrit.
 */
async function debitInvoices(
  deps: RecoveryBillingDeps,
  options: RecoveryBillingOptions,
  invoices: readonly CommissionInvoice[],
  now: Date,
): Promise<{ paid: number; failures: CommissionDebitFailureReport[] }> {
  let paid = 0;
  const failures: CommissionDebitFailureReport[] = [];
  for (const invoice of invoices) {
    const amount = commissionBalance(invoice);
    if (amount <= 0) continue;
    try {
      const debit = await deps.wallet.debit({
        idempotencyKey: commissionDebitKey(invoice.id),
        holder: invoice.creditor,
        amount,
        object: { objectType: COMMISSION_DEBIT_OBJECT_TYPE, objectId: invoice.id, part: '' },
        description: `Commission de recouvrement — facture ${invoice.number}`,
      });
      if (await deps.recovery.saveDebit(withCommissionDebited(invoice, debit.transactionId, now))) {
        paid += 1;
      }
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'WALLET_UNAVAILABLE';
      const reason: CommissionDebitFailure =
        code === 'WALLET_INSUFFICIENT_FUNDS' ? 'insufficient_funds' : 'wallet_error';
      const delay = reason === 'insufficient_funds' ? options.debitRetryDelayMs : WALLET_ERROR_RETRY_MS;
      await deps.recovery.saveDebit(
        withCommissionDebitFailed(invoice, {
          reason,
          missingAmount: missingAmount(error),
          at: now,
          nextAttemptAt: new Date(now.getTime() + delay),
        }),
      );
      failures.push({ invoiceId: invoice.id, invoiceNumber: invoice.number, reason, code });
    }
  }
  return { paid, failures };
}

/** Montant manquant rappelé par wallet (`details.missing`, ADR-046), ou null. */
function missingAmount(error: unknown): number | null {
  if (!(error instanceof AppError)) return null;
  const missing = (error.details as { missing?: { amount?: unknown } }).missing?.amount;
  return typeof missing === 'number' && Number.isInteger(missing) && missing > 0 ? missing : null;
}

function statusFilter(status: string): CommissionInvoiceStatus | undefined {
  return status ? oneOf('status', status, COMMISSION_INVOICE_STATUSES) : undefined;
}

/** Mois facturé AAAA-MM (chaîne vide = absent). */
function periodFilter(period: string): Date | undefined {
  if (!period) return undefined;
  const month = parsePeriod(period);
  if (!month) throw BillingErrors.invalid('period', 'Mois attendu au format AAAA-MM.');
  return month.start;
}

/** Créancier du client : son organisation active, sinon son compte. */
function creditorOf(scope: CustomerScope): CreditorRef {
  return scope.organizationId
    ? { type: 'organization', id: scope.organizationId.toLowerCase() }
    : { type: 'user', id: scope.userId.toLowerCase() };
}

const sameParty = (a: CreditorRef, b: CreditorRef) =>
  a.type === b.type && a.id.toLowerCase() === b.id.toLowerCase();

/** Factures de commission du client : son compte, ou son organisation active (tout membre). */
export class ListMyCommissionInvoicesUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(input: {
    page: PageRequest;
    status: string;
    period: string;
  }): Promise<PageResult<CommissionInvoice>> {
    const creditor = creditorOf(currentCustomer());
    const status = statusFilter(input.status);
    const periodStart = periodFilter(input.period);
    const filter: CommissionInvoiceFilter = {
      creditor,
      ...(status ? { status } : {}),
      ...(periodStart ? { periodStart } : {}),
    };
    return this.deps.recovery.listCommissionInvoices(filter, input.page);
  }
}

/** Détail d'une de mes factures de commission ; hors périmètre : 404, sans révéler son existence. */
export class GetMyCommissionInvoiceUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(invoiceId: string): Promise<CommissionInvoice> {
    const creditor = creditorOf(currentCustomer());
    const invoice = await this.deps.recovery.findCommissionInvoice(requireUuid('invoiceId', invoiceId));
    if (!invoice || !sameParty(invoice.creditor, creditor)) throw BillingErrors.invoiceNotFound();
    return invoice;
  }
}

/** Back-office : toutes les factures de commission, filtrables (finance ; recovery_admin en lecture). */
export class ListCommissionInvoicesUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(input: {
    page: PageRequest;
    status: string;
    period: string;
    creditorId: string;
  }): Promise<PageResult<CommissionInvoice>> {
    requireStaff(RECOVERY_BILLING_STAFF);
    const status = statusFilter(input.status);
    const periodStart = periodFilter(input.period);
    const creditorId = optionalUuid('creditorId', input.creditorId);
    return this.deps.recovery.listCommissionInvoices(
      {
        ...(status ? { status } : {}),
        ...(periodStart ? { periodStart } : {}),
        ...(creditorId ? { creditorId } : {}),
      },
      input.page,
    );
  }
}

export class GetCommissionInvoiceUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(invoiceId: string): Promise<CommissionInvoice> {
    requireStaff(RECOVERY_BILLING_STAFF);
    const invoice = await this.deps.recovery.findCommissionInvoice(requireUuid('invoiceId', invoiceId));
    if (!invoice) throw BillingErrors.invoiceNotFound();
    return invoice;
  }
}

/**
 * ksp.common.v1.ObligationService.HasPendingObligations, part du recouvrement (UC-ID-11, ADR-036) :
 * une facture de commission encore due du compte bloque sa suppression, comme une facture impayée du
 * Nettoyage (`unpaid_invoice`). Celle d'une organisation ne compte que si identity la désigne
 * (`organizationId`) : l'organisation survit au départ d'un membre (comme son portefeuille).
 */
export class HasPendingCommissionObligationsUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(input: { userId: string; organizationId: string }): Promise<PendingObligation[]> {
    requireCaller(['identity']);
    const creditors: CreditorRef[] = [{ type: 'user', id: requireUuid('userId', input.userId) }];
    const organizationId = optionalUuid('organizationId', input.organizationId);
    if (organizationId) creditors.push({ type: 'organization', id: organizationId });
    const invoices = await this.deps.recovery.listUnpaidForCreditors(creditors);
    return invoices.map((invoice) => ({
      kind: 'unpaid_invoice',
      reference: invoice.number,
      description:
        `La facture de commission ${invoice.number} (${formatAmount(commissionBalance(invoice))} hors taxe) ` +
        'est en attente de paiement : elle sera débitée du portefeuille dès que son solde suffira.',
    }));
  }
}
