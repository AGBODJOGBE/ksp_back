/**
 * Événements publiés par billing (facturation mensuelle des contrats d'entreprise, CDC
 * Nettoyage partie 10). Source de vérité : contracts/events/billing/*.schema.json. Identifiants
 * et montants seulement.
 *
 * `billing.invoice.issued`, `.overdue` et `.paid` existent en versions 1 et 2 (RV-98) : la v1 porte
 * le contrat (facture v1) ; la v2, publiée pour toute facture v2 (séance, frais de visite, facture
 * mensuelle d'organisation), n'a pas de contrat et porte toujours `kind`, le compte des impayés du
 * titulaire et, pour `paid`, `settledBy`. Un consommateur déclare `versions: [1, 2]`.
 */
export interface BillingMoney {
  amount: number;
  currency: 'XOF';
}

/** Service métier à l'origine du contrat facturé. */
export type BillingSource = 'cleaning';

/** v2 : facture de séance, reçu des frais de visite, facture mensuelle d'organisation. */
export type InvoiceKind = 'session' | 'visit_fee' | 'monthly';

/** v2 : comment une facture a été soldée (paiement, avoir qui ramène le reste dû à 0, annulation). */
export type InvoiceSettlement = 'payment' | 'credit_note' | 'cancellation';

interface InvoiceRef {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  organizationId: string | null;
  source: BillingSource;
  /** v1 seulement : contrat chez le service source (pour cleaning : la mission). Absent en v2. */
  contractId?: string;
  total: BillingMoney;
}

export interface BillingEventPayloads {
  'billing.invoice.issued': InvoiceRef & {
    periodStart: string;
    periodEnd: string;
    issuedAt: string;
    dueAt: string;
    kind?: InvoiceKind;
    /** v2 : `paid` pour une facture émise au paiement (séance, frais de visite). */
    status?: 'pending_payment' | 'paid';
  };
  'billing.invoice.overdue': InvoiceRef & {
    dueAt: string;
    /** Factures impayées du contrat (v1) ou du titulaire (v2), celle-ci comprise. */
    overdueCount: number;
    kind?: InvoiceKind;
    /** v2 : factures impayées du titulaire, celle-ci comprise ; information seulement (cleaning tient son propre compte). */
    holderOverdueCount?: number;
  };
  'billing.invoice.paid': InvoiceRef & {
    paidAt: string;
    /** Factures du contrat (v1) ou du titulaire (v2) encore impayées après ce règlement. */
    overdueCount: number;
    kind?: InvoiceKind;
    /** v2 : factures du titulaire encore impayées après ce règlement ; information seulement (cleaning tient son propre compte). */
    holderOverdueCount?: number;
    /** v2 : comment la facture a été soldée. */
    settledBy?: InvoiceSettlement;
  };
  /** Relance automatique d'une facture d'organisation (R-PE-05). */
  'billing.invoice.reminded': {
    invoiceId: string;
    invoiceNumber: string;
    customerId: string;
    organizationId: string | null;
    total: BillingMoney;
    balance: BillingMoney;
    dueAt: string;
    /** Jours par rapport à l'échéance (négatif : avant). */
    offsetDays: number;
    remindedAt: string;
  };
  /** Avoir émis sur une facture (R-PE-07). */
  'billing.credit_note.issued': {
    creditNoteId: string;
    creditNoteNumber: string;
    invoiceId: string;
    invoiceNumber: string;
    customerId: string;
    organizationId: string | null;
    total: BillingMoney;
    appliedToBalance: BillingMoney;
    creditedToWallet: BillingMoney;
    issuedAt: string;
  };
}

export type BillingEventType = keyof BillingEventPayloads;
