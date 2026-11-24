import { type AssignmentState, isUpcoming } from '../planning/assignment-status';
import { isTerminalProgram, type ProgramStatus } from '../programs/program-status';
import { isOpenRequest, type RequestTimeline } from '../requests/request-status';

/**
 * Obligations qui empêchent la suppression d'un compte (partie 3 : « refusée tant qu'un programme,
 * une demande ou un impayé est en cours » ; ksp.common.v1.ObligationService, ADR-036). Le domaine
 * reçoit ce qui est enregistré et décide d'après l'heure : statut effectif d'une demande (RV-14),
 * affectation à venir d'un agent (R-AG-03), page de paiement encore ouverte. Une obligation par
 * nature et par dossier : le numéro de la demande ou du programme, jamais d'adresse, de position ni
 * de montant.
 */
export type ObligationKind =
  | 'open_cleaning_request'
  | 'open_cleaning_program'
  | 'unpaid_cleaning_session'
  | 'cleaning_payment_in_progress'
  | 'unpaid_cleaning_invoice'
  | 'upcoming_cleaning_assignment';

/** Valeurs de ksp.common.v1.PendingObligation. */
export interface PendingObligation {
  /** Nature stable, lue par identity. */
  kind: ObligationKind;
  /** Numéro de la demande (DN-…) ou du programme (PN-…) ; vide quand l'obligation n'en vise aucun. */
  reference: string;
  /** Explication affichée à l'utilisateur. */
  description: string;
}

export interface RequestFact {
  number: string;
  timeline: RequestTimeline;
}

export interface ProgramFact {
  number: string;
  status: ProgramStatus;
  /** Séances ni réalisées, ni manquées, ni annulées. */
  openSessions: number;
}

/** Séance « à payer » ou « en retard » (partie 11.1). */
export interface UnpaidSessionFact {
  programNumber: string;
  rank: number;
}

/** Dossier visé par un mouvement d'argent ; null : aucun (geste commercial sans dossier). */
export interface MoneySubject {
  subject: 'request' | 'program' | null;
  reference: string | null;
}

/** Paiement direct par Mobile Money pas encore abouti (R-WL-05). */
export interface DirectPaymentFact extends MoneySubject {
  createdAt: Date;
  /** Échéance de la page de paiement ; null tant que payment ne l'a pas rendue. */
  expiresAt: Date | null;
}

/** Affectation d'un agent à une visite (numéro de la demande) ou à une séance (numéro du programme). */
export interface AssignmentFact extends AssignmentState {
  target: 'visit' | 'session';
  reference: string;
  /** Fin de la période occupée. */
  end: Date;
}

export interface ObligationFacts {
  /** Demandes du titulaire, avec ce que leur statut doit savoir de l'heure. */
  requests: readonly RequestFact[];
  programs: readonly ProgramFact[];
  unpaidSessions: readonly UnpaidSessionFact[];
  /** Opérations envoyées au wallet dont l'issue n'est pas encore connue (15.4). */
  walletOperations: readonly MoneySubject[];
  directPayments: readonly DirectPaymentFact[];
  /** Factures mensuelles impayées d'une organisation (R-PE-06) ; 0 pour un compte personnel. */
  overdueInvoices: number;
  /** Affectations du compte s'il est agent ; vide sinon. */
  assignments: readonly AssignmentFact[];
}

/** Durée de vie d'une page de paiement Mobile Money (R-PP-07 : 72 h au plus). */
export const DIRECT_PAYMENT_PAGE_HOURS = 72;
const HOUR_MS = 3_600_000;

const byReference = (a: PendingObligation, b: PendingObligation) =>
  a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;

/** Nombre d'éléments par clé, dans l'ordre des clés. */
function countBy<T>(items: readonly T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Programme non terminé (partie 8 : « terminé » quand toutes les séances prévues sont réalisées,
 * manquées ou annulées). Un programme terminé auquel une réclamation a ajouté une repasse gratuite
 * (R-RC-03) attend encore une séance : il compte aussi.
 */
function isOpenProgram(program: ProgramFact): boolean {
  return !isTerminalProgram(program.status) || program.openSessions > 0;
}

/**
 * Page de paiement encore ouverte : le client peut encore payer, puis le wallet sera crédité et
 * débité. Sans échéance connue, la page compte pendant sa durée de vie la plus longue.
 */
function isLivePayment(payment: DirectPaymentFact, now: Date): boolean {
  const expiresAt =
    payment.expiresAt ?? new Date(payment.createdAt.getTime() + DIRECT_PAYMENT_PAGE_HOURS * HOUR_MS);
  return expiresAt.getTime() > now.getTime();
}

function paymentObligation(money: MoneySubject): PendingObligation {
  const about =
    money.reference === null || money.subject === null
      ? null
      : money.subject === 'request'
        ? `la demande ${money.reference}`
        : `le programme ${money.reference}`;
  return {
    kind: 'cleaning_payment_in_progress',
    reference: about ? (money.reference as string) : '',
    description: about
      ? `Un paiement est en cours pour ${about} : attendez qu'il aboutisse.`
      : "Un paiement de nettoyage est en cours : attendez qu'il aboutisse.",
  };
}

function assignmentObligation(target: 'visit' | 'session', reference: string, count: number) {
  const where =
    target === 'visit'
      ? `${count === 1 ? 'une visite' : `${count} visites`} de la demande ${reference}`
      : `${count === 1 ? 'une séance' : `${count} séances`} du programme ${reference}`;
  return {
    kind: 'upcoming_cleaning_assignment' as const,
    reference,
    description: `Vous êtes attendu sur ${where} : demandez d'abord votre remplacement.`,
  };
}

/** Obligations en cours, dans un ordre stable : par nature, puis par numéro. */
export function pendingObligations(facts: ObligationFacts, now: Date): PendingObligation[] {
  const requests: PendingObligation[] = facts.requests
    .filter((request) => isOpenRequest(request.timeline, now))
    .map((request) => ({
      kind: 'open_cleaning_request',
      reference: request.number,
      description: `La demande de nettoyage ${request.number} est en cours : annulez-la ou attendez sa clôture.`,
    }));

  const programs: PendingObligation[] = facts.programs.filter(isOpenProgram).map((program) => ({
    kind: 'open_cleaning_program',
    reference: program.number,
    description: `Le programme de nettoyage ${program.number} n'est pas terminé : arrêtez-le ou attendez sa fin.`,
  }));

  const unpaid: PendingObligation[] = countBy(facts.unpaidSessions, (session) => session.programNumber).map(
    ([number, count]) => ({
      kind: 'unpaid_cleaning_session',
      reference: number,
      description:
        count === 1
          ? `Une séance du programme ${number} reste à payer.`
          : `${count} séances du programme ${number} restent à payer.`,
    }),
  );

  const payments = new Map<string, PendingObligation>();
  for (const money of [
    ...facts.walletOperations,
    ...facts.directPayments.filter((payment) => isLivePayment(payment, now)),
  ]) {
    const obligation = paymentObligation(money);
    if (!payments.has(obligation.reference)) payments.set(obligation.reference, obligation);
  }

  const invoices: PendingObligation[] =
    facts.overdueInvoices > 0
      ? [
          {
            kind: 'unpaid_cleaning_invoice',
            reference: '',
            description:
              facts.overdueInvoices === 1
                ? "Une facture mensuelle de nettoyage de l'organisation est impayée."
                : `${facts.overdueInvoices} factures mensuelles de nettoyage de l'organisation sont impayées.`,
          },
        ]
      : [];

  const upcoming = facts.assignments.filter((assignment) => isUpcoming(assignment, now));
  const assignments: PendingObligation[] = countBy(
    upcoming,
    (assignment) => `${assignment.reference}|${assignment.target}`,
  ).map(([key, count]) => {
    const [reference, target] = key.split('|') as [string, 'visit' | 'session'];
    return assignmentObligation(target, reference, count);
  });

  return [
    ...requests.sort(byReference),
    ...programs.sort(byReference),
    ...unpaid,
    ...[...payments.values()].sort(byReference),
    ...invoices,
    ...assignments,
  ];
}
