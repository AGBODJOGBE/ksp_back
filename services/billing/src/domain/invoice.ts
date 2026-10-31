import { type BillingSource, type ContractPeriod } from './contract';

/**
 * Facture (CDC Nettoyage, partie 10) : « en attente de paiement » jusqu'à l'échéance
 * (émission + délai de règlement), puis « impayée » ; « payée » quand les paiements atteignent
 * le total. « annulée » est réservée à une correction future ; aucune route ne l'utilise encore.
 */
export type InvoiceStatus = 'pending_payment' | 'overdue' | 'paid' | 'cancelled';
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['pending_payment', 'overdue', 'paid', 'cancelled'];

/**
 * Moyens de paiement : ceux du back-office (MANUAL_PAYMENT_METHODS), et `mobile_money_online`,
 * paiement en ligne confirmé par le prestataire et enregistré par le système (ADR-031).
 */
export type PaymentMethod = 'cash' | 'bank_transfer' | 'mobile_money_offline' | 'mobile_money_online';
export const MANUAL_PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'bank_transfer',
  'mobile_money_offline',
];

const TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  pending_payment: ['overdue', 'paid', 'cancelled'],
  overdue: ['paid', 'cancelled'],
  paid: [],
  cancelled: [],
};

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface InvoiceLine {
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  recordedBy: string;
  recordedAt: Date;
}

/**
 * En-tête d'une facture d'organisation : la fiche lue dans identity au moment de l'émission.
 * La facture est un document comptable : une modification ultérieure de la fiche ne la change
 * pas. Aucun champ fiscal au-delà de l'IFU et du RCCM (pas de TVA).
 */
export interface InvoiceOrganization {
  /** Raison sociale. */
  legalName: string;
  address: string;
  /** Identifiant fiscal unique (Bénin), 13 chiffres. */
  ifu: string;
  /** Registre du commerce, facultatif. */
  rccm: string | null;
}

export interface Invoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  contractId: string;
  customerId: string;
  organizationId: string | null;
  source: BillingSource;
  periodIndex: number;
  periodStart: Date;
  periodEnd: Date;
  lines: InvoiceLine[];
  total: number;
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
  payments: InvoicePayment[];
  /** En-tête de l'organisation facturée ; null pour une facture émise avant son enregistrement. */
  organization: InvoiceOrganization | null;
  version: number;
}

const DAY_MS = 86_400_000;

/** Échéance : émission + délai de règlement (10 jours par défaut). */
export function dueDate(issuedAt: Date, paymentTermDays: number): Date {
  return new Date(issuedAt.getTime() + paymentTermDays * DAY_MS);
}

/** Numéro lisible, continu par année : FAC-2026-000042. */
export function formatInvoiceNumber(year: number, sequence: number): string {
  return `FAC-${year}-${String(sequence).padStart(6, '0')}`;
}

export function paidAmount(invoice: Pick<Invoice, 'payments'>): number {
  return invoice.payments.reduce((sum, payment) => sum + payment.amount, 0);
}

export function balance(invoice: Pick<Invoice, 'payments' | 'total'>): number {
  return Math.max(0, invoice.total - paidAmount(invoice));
}

/** Échéance dépassée sans règlement complet. */
export function isOverdue(invoice: Pick<Invoice, 'status' | 'dueAt'>, now: Date): boolean {
  return invoice.status === 'pending_payment' && invoice.dueAt <= now;
}

export type PaymentRefusal = 'amount_invalid' | 'method_not_allowed' | 'exceeds_balance';

/** Raison du refus d'un paiement manuel, ou null s'il est acceptable (jamais au-delà du reste dû). */
export function paymentRefusal(
  invoice: Pick<Invoice, 'payments' | 'total'>,
  amount: number,
  method: string,
): PaymentRefusal | null {
  if (!Number.isInteger(amount) || amount <= 0) return 'amount_invalid';
  if (!MANUAL_PAYMENT_METHODS.includes(method as PaymentMethod)) return 'method_not_allowed';
  if (amount > balance(invoice)) return 'exceeds_balance';
  return null;
}

/**
 * Facture après un paiement en ligne (ADR-031). L'argent reçu est toujours enregistré : sur une
 * facture déjà payée ou annulée (paiement tardif), il s'ajoute sans changer son état (excédent à
 * rembourser, différé) ; sinon, la facture devient payée quand le total est atteint.
 */
export function withOnlinePayment(invoice: Invoice, payment: InvoicePayment): Invoice {
  if (invoice.status === 'paid' || invoice.status === 'cancelled') {
    return { ...invoice, payments: [...invoice.payments, payment] };
  }
  return withPayment(invoice, payment);
}

/** Facture après un paiement : payée quand le total est atteint. */
export function withPayment(invoice: Invoice, payment: InvoicePayment): Invoice {
  const next = { ...invoice, payments: [...invoice.payments, payment] };
  return balance(next) === 0 ? { ...next, status: 'paid', paidAt: payment.recordedAt } : next;
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

const days = (count: number) => `${count} jour${count > 1 ? 's' : ''}`;

/**
 * Ligne d'une facture mensuelle : le mois civil, les jours facturés sur les jours du mois et,
 * s'il y en a, les jours de suspension déduits. Forfait (quantité 1) au montant proratisé.
 */
export function periodLines(period: ContractPeriod): InvoiceLine[] {
  const billed = period.contractDays - period.suspendedDays;
  const suspension = period.suspendedDays ? `, ${days(period.suspendedDays)} de suspension déduits` : '';
  return [
    {
      label:
        `Prestation de nettoyage — ${MONTHS[period.month - 1]} ${period.year} : ` +
        `${days(billed)} sur ${period.daysInMonth}${suspension}`,
      quantity: 1,
      unitPrice: period.amount,
      amount: period.amount,
    },
  ];
}
