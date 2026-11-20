import { createHash } from 'node:crypto';
import { requireRecentMfa } from '@ksp/platform';
import {
  cancelInvoice,
  type CreditNote,
  type CreditNoteSource,
  creditNoteProblem,
  splitCreditNote,
  withCreditNote,
} from '../../domain/credit-note';
import { type Invoice, type InvoiceLine } from '../../domain/invoice';
import { requireCaller, requireStaff } from '../shared/access';
import { BillingErrors } from '../shared/errors';
import { requireUuid } from '../shared/validation';
import { MonthlyBillingErrors } from './errors';
import { paidEvent } from './invoice-events';
import { type MonthlyBillingDeps } from './ports';

/** Services autorisés à émettre un avoir (billing.proto : BILLING_ISSUER_CALLERS). */
export const CREDIT_NOTE_ISSUER_CALLERS = ['cleaning'] as const;
/** Écritures d'argent du back-office (billing.proto, BillingAdminService). */
export const CREDIT_NOTE_STAFF = ['finance_officer', 'super_admin'] as const;
/** Action sensible : double authentification de moins de 10 minutes (partie 16.3). */
export const SENSITIVE_MFA_MAX_AGE_SECONDS = 600;

const ISSUANCE_KEY = /^[A-Za-z0-9:_-]{8,150}$/;
const MAX_ATTEMPTS = 3;

export interface CreditNoteRequest {
  idempotencyKey: string;
  invoiceId: string;
  lines: InvoiceLine[];
  reason: string;
  source?: CreditNoteSource | null;
}

export interface CreditNoteResult {
  creditNote: CreditNote;
  invoice: Invoice;
  /** false : avoir déjà émis avec cette clé. */
  created: boolean;
}

/**
 * Émission d'un avoir (R-PE-07, R-RC-03), commune au service cleaning et au back-office : imputé
 * d'abord sur le reste dû, le reste crédité au portefeuille du titulaire (R-WL-04) ; un avoir qui
 * ramène le reste dû à 0 solde la facture (`billing.invoice.paid` v2, settledBy credit_note).
 * Idempotent par (émetteur, clé) : la même clé rend le même avoir ; une clé déjà utilisée pour une
 * autre facture est refusée (BILLING_IDEMPOTENCY_KEY_REUSED).
 */
class CreditNoteIssuer {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async issue(issuedBy: string, request: CreditNoteRequest): Promise<CreditNoteResult> {
    if (!ISSUANCE_KEY.test(request.idempotencyKey)) {
      throw BillingErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 150 caractères).');
    }
    const invoiceId = requireUuid('invoiceId', request.invoiceId);
    const replayed = await this.replay(issuedBy, request.idempotencyKey, invoiceId);
    if (replayed) return replayed;
    const problem = creditNoteProblem(request.lines, request.reason);
    if (problem) throw BillingErrors.invalid(problem);
    const total = request.lines.reduce((sum, line) => sum + line.amount, 0);
    // Clé du crédit au portefeuille, fixe pour (émetteur, clé) : un rejeu ne crédite qu'une fois.
    const walletKey = `billing_credit_note:${createHash('sha256').update(`${issuedBy}|${request.idempotencyKey}`).digest('hex').slice(0, 40)}`;
    let credited: { amount: number; transactionId: string } | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const invoice = await this.deps.invoices.findById(invoiceId);
      if (!invoice) throw BillingErrors.invoiceNotFound();
      const split = splitCreditNote(invoice, total);
      if ('code' in split) {
        if (split.code === 'exceeds_invoice')
          throw MonthlyBillingErrors.creditNoteExceedsInvoice(split.maximum);
        throw BillingErrors.invalidTransition(split.status, 'credited');
      }
      if (split.creditedToWallet > 0 && !credited) {
        const { transactionId } = await this.deps.walletCredits.credit({
          idempotencyKey: walletKey,
          holder: invoice.organizationId
            ? { type: 'organization', id: invoice.organizationId }
            : { type: 'user', id: invoice.customerId },
          amount: split.creditedToWallet,
          object: { objectType: 'billing_invoice', objectId: invoice.id },
          description: `Avoir sur la facture ${invoice.number}`,
        });
        credited = { amount: split.creditedToWallet, transactionId };
      }
      // Le crédit déjà fait fixe la part du portefeuille : une facture changée entre-temps est refusée.
      if ((credited?.amount ?? 0) !== split.creditedToWallet) throw BillingErrors.concurrentUpdate();
      const now = this.deps.clock.now();
      const { invoice: updated, settled } = withCreditNote(invoice, split, now);
      const note: Omit<CreditNote, 'number'> = {
        id: this.deps.ids.next(),
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        customerId: invoice.customerId,
        organizationId: invoice.organizationId,
        lines: request.lines,
        total,
        reason: request.reason.trim(),
        issuedBy,
        issuedAt: now,
        appliedToBalance: split.appliedToBalance,
        creditedToWallet: split.creditedToWallet,
        walletTransactionId: credited?.transactionId ?? null,
        source: request.source ?? null,
        idempotencyKey: request.idempotencyKey,
      };
      let saved: CreditNote | 'conflict';
      try {
        saved = await this.deps.monthly.saveCreditNote(updated, note, (created, overdueCount) => [
          {
            type: 'billing.credit_note.issued',
            payload: {
              creditNoteId: created.id,
              creditNoteNumber: created.number,
              invoiceId: created.invoiceId,
              invoiceNumber: created.invoiceNumber,
              customerId: created.customerId,
              organizationId: created.organizationId,
              total: { amount: created.total, currency: 'XOF' },
              appliedToBalance: { amount: created.appliedToBalance, currency: 'XOF' },
              creditedToWallet: { amount: created.creditedToWallet, currency: 'XOF' },
              issuedAt: created.issuedAt.toISOString(),
            },
          },
          ...(settled ? [paidEvent(updated, now, overdueCount, 'credit_note')] : []),
        ]);
      } catch (error) {
        // Unicité (émetteur, clé) : un envoi concurrent de la même clé vient d'être enregistré.
        const concurrent = await this.replay(issuedBy, request.idempotencyKey, invoiceId);
        if (concurrent) return concurrent;
        throw error;
      }
      if (saved !== 'conflict')
        return { creditNote: saved, invoice: { ...updated, version: updated.version + 1 }, created: true };
    }
    throw BillingErrors.concurrentUpdate();
  }

  private async replay(issuedBy: string, key: string, invoiceId: string): Promise<CreditNoteResult | null> {
    const existing = await this.deps.monthly.findCreditNoteByKey(issuedBy, key);
    if (!existing) return null;
    if (existing.invoiceId !== invoiceId) throw MonthlyBillingErrors.idempotencyKeyReused();
    const invoice = await this.deps.invoices.findById(invoiceId);
    if (!invoice) throw BillingErrors.invoiceNotFound();
    return { creditNote: existing, invoice, created: false };
  }
}

/** InvoiceIssuanceService.IssueCreditNote : avoir demandé par cleaning (réclamation d'une entreprise). */
export class IssueCreditNoteUseCase {
  private readonly issuer: CreditNoteIssuer;

  constructor(deps: MonthlyBillingDeps) {
    this.issuer = new CreditNoteIssuer(deps);
  }

  async execute(request: CreditNoteRequest): Promise<CreditNoteResult> {
    requireCaller(CREDIT_NOTE_ISSUER_CALLERS);
    return this.issuer.issue('service:cleaning', request);
  }
}

/** BillingAdminService.IssueAdminCreditNote : avoir saisi par la finance (double authentification récente). */
export class IssueAdminCreditNoteUseCase {
  private readonly issuer: CreditNoteIssuer;

  constructor(deps: MonthlyBillingDeps) {
    this.issuer = new CreditNoteIssuer(deps);
  }

  async execute(request: Omit<CreditNoteRequest, 'source'>): Promise<CreditNoteResult> {
    const staff = requireStaff(CREDIT_NOTE_STAFF);
    requireRecentMfa(SENSITIVE_MFA_MAX_AGE_SECONDS);
    return this.issuer.issue(staff.userId, { ...request, source: null });
  }
}

/** Avoirs d'une facture (back-office). */
export class ListInvoiceCreditNotesUseCase {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async execute(invoiceId: string): Promise<CreditNote[]> {
    requireStaff(CREDIT_NOTE_STAFF);
    return this.deps.monthly.listCreditNotes(requireUuid('invoiceId', invoiceId));
  }
}

/**
 * Annulation d'une facture v2 ouverte, sans paiement (finance, double authentification récente) :
 * elle sort des impayés (`billing.invoice.paid` v2, settledBy cancellation). `releaseSessions` :
 * ses séances repartent sur la facture suivante (en-tête ou regroupement à refaire).
 * Interprétation : billing.proto n'a pas de méthode d'annulation ; ce cas d'usage n'est pas exposé.
 */
export class CancelInvoiceUseCase {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async execute(input: { invoiceId: string; releaseSessions: boolean }): Promise<Invoice> {
    requireStaff(CREDIT_NOTE_STAFF);
    requireRecentMfa(SENSITIVE_MFA_MAX_AGE_SECONDS);
    const invoice = await this.deps.invoices.findById(requireUuid('invoiceId', input.invoiceId));
    if (!invoice) throw BillingErrors.invoiceNotFound();
    const result = cancelInvoice(invoice);
    if ('refusal' in result) {
      if (result.refusal === 'partially_paid') throw BillingErrors.paymentInvalid('partially_paid');
      throw BillingErrors.invalidTransition(invoice.status, 'cancelled');
    }
    const now = this.deps.clock.now();
    const cancelled = result.invoice;
    const saved = await this.deps.monthly.cancel(cancelled, input.releaseSessions, (overdueCount) => [
      paidEvent(cancelled, now, overdueCount, 'cancellation'),
    ]);
    if (!saved) throw BillingErrors.concurrentUpdate();
    return { ...cancelled, version: cancelled.version + 1 };
  }
}
