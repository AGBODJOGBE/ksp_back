import { z } from 'zod';
import { formatAmount, formatCalendarDate } from '../format';
import { calendarDate, type DocumentTemplate, line, place, reference } from './template';

/**
 * Relevé mensuel d'un dossier, version 1 : adressé au créancier, il détaille pour le mois chaque
 * encaissement, la commission de KSP, les frais retenus et le montant crédité sur son portefeuille
 * (R-CO-05). La facture de commission est émise à part par `billing`. Jamais signé.
 * À faire relire par l'avocat avec le mandat : libellés de la commission et des frais retenus.
 */
const money = z.int().min(0).max(100_000_000_000);

const movement = z.strictObject({
  date: calendarDate,
  /** Libellé (« Paiement Mobile Money, échéance 2/6 »). */
  label: line(200),
  collected: money,
  commission: money,
  costs: money,
  /** Crédité au portefeuille du créancier : encaissé − commission − frais. */
  remitted: money,
});

const schema = z
  .strictObject({
    caseReference: reference,
    creditor: z.strictObject({
      name: line(200),
      /** IFU, RCCM ou numéro de pièce d'identité. */
      identification: line(100).optional(),
    }),
    debtor: z.strictObject({ name: line(200) }),
    /** Mois du relevé, « AAAA-MM ». */
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mois « AAAA-MM » attendu.'),
    /** Mouvements du mois ; vide : aucun encaissement ce mois-ci. */
    movements: z.array(movement).max(500),
    /** Situation du dossier à la fin du mois. */
    situation: z.strictObject({
      /** Étape ou statut en clair (« Échéancier en cours »). */
      status: line(80),
      /** Total encaissé depuis l'ouverture. */
      collectedToDate: money,
      /** Montant restant dû par le débiteur. */
      outstanding: money,
    }),
    place,
  })
  .superRefine((v, ctx) => {
    v.movements.forEach((item, index) => {
      if (!item.date.startsWith(`${v.month}-`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['movements', index, 'date'],
          message: 'Le mouvement doit appartenir au mois du relevé.',
        });
      }
      if (item.collected - item.commission - item.costs !== item.remitted) {
        ctx.addIssue({
          code: 'custom',
          path: ['movements', index, 'remitted'],
          message: 'Le montant crédité doit être l’encaissé moins la commission et les frais.',
        });
      }
      const previous = v.movements[index - 1];
      if (previous && item.date < previous.date) {
        ctx.addIssue({
          code: 'custom',
          path: ['movements', index, 'date'],
          message: 'Les mouvements doivent être dans l’ordre des dates.',
        });
      }
    });
    const collected = v.movements.reduce((total, item) => total + item.collected, 0);
    if (v.situation.collectedToDate < collected) {
      ctx.addIssue({
        code: 'custom',
        path: ['situation', 'collectedToDate'],
        message: 'Le total encaissé depuis l’ouverture ne peut pas être inférieur à celui du mois.',
      });
    }
  });

export type RecoveryStatementV1 = z.infer<typeof schema>;

/** « 2026-11 » → « novembre 2026 ». */
function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-15T12:00:00Z`),
  );
}

export const recoveryStatementV1: DocumentTemplate<RecoveryStatementV1> = {
  code: 'recovery_statement',
  version: 1,
  numberPrefix: 'REL',
  signature: 'none',
  services: ['recovery'],
  schema,
  title: (v) => `Relevé du dossier, ${monthLabel(v.month)}`,
  place: (v) => v.place,
  build: (v, { issuer }) => {
    const sum = (key: 'collected' | 'commission' | 'costs' | 'remitted') =>
      v.movements.reduce((total, item) => total + item[key], 0);
    const creditor: [string, string][] = [['Créancier', v.creditor.name]];
    if (v.creditor.identification) creditor.push(['Identification', v.creditor.identification]);
    creditor.push(
      ['Débiteur', v.debtor.name],
      ['Dossier', v.caseReference],
      ['Période', monthLabel(v.month)],
    );

    return [
      { kind: 'fields', rows: creditor },
      { kind: 'heading', text: 'Mouvements du mois' },
      v.movements.length === 0
        ? { kind: 'paragraph', text: 'Aucun encaissement n’a été reçu sur ce dossier pendant le mois.' }
        : {
            kind: 'table',
            columns: ['Date', 'Libellé', 'Encaissé', 'Commission', 'Frais', 'Crédité'],
            align: ['left', 'left', 'right', 'right', 'right', 'right'],
            rows: v.movements.map((item) => [
              formatCalendarDate(item.date),
              item.label,
              formatAmount(item.collected),
              formatAmount(item.commission),
              formatAmount(item.costs),
              formatAmount(item.remitted),
            ]),
            totalRow: [
              'Total',
              '',
              formatAmount(sum('collected')),
              formatAmount(sum('commission')),
              formatAmount(sum('costs')),
              formatAmount(sum('remitted')),
            ],
          },
      { kind: 'heading', text: 'Situation du dossier en fin de mois' },
      {
        kind: 'fields',
        rows: [
          ['Statut', v.situation.status],
          ['Encaissé depuis l’ouverture', formatAmount(v.situation.collectedToDate)],
          ['Restant dû par le débiteur', formatAmount(v.situation.outstanding)],
        ],
      },
      {
        kind: 'paragraph',
        text:
          'Les montants crédités sont disponibles sur votre portefeuille KSP, d’où vous pouvez demander ' +
          `un retrait. La facture de commission du mois est émise séparément par ${issuer.name}.`,
      },
    ];
  },
};
