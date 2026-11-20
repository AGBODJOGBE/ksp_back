import { z } from 'zod';
import { type Block } from '../content';
import { formatAmount, formatDateTime } from '../format';
import { amount, type DocumentTemplate, line, place, reference } from './template';

/**
 * Reçu d'un paiement du débiteur, version 1 : remis à chaque paiement reçu par KSP pour le compte
 * du créancier, avec le montant restant dû (R-EN-02) et, si la décomposition du montant dû est
 * fournie, l'imputation du paiement, calculée ici dans l'ordre fixé : frais, puis intérêts, puis
 * principal (R-EN-03). Le reçu ne peut donc pas imprimer une imputation contraire à cet ordre.
 * Jamais signé.
 * À faire relire par l'avocat : mention « ne vaut pas quittance du solde » et rédaction du trop-perçu.
 */
const money = z.int().min(0).max(100_000_000_000);

const METHOD = {
  mobile_money: 'Mobile Money',
  card: 'Carte bancaire',
  bank_transfer: 'Virement bancaire',
  cash: 'Espèces au guichet KSP',
} as const;

const schema = z
  .strictObject({
    caseReference: reference,
    creditor: z.strictObject({ name: line(200) }),
    payer: z.strictObject({ name: line(200) }),
    payment: z.strictObject({
      /** Horodatage UTC ISO 8601 de la réception. */
      paidAt: z.iso.datetime(),
      amount,
      method: z.enum(['mobile_money', 'card', 'bank_transfer', 'cash']),
      /** Référence de l'opération (prestataire, virement, bordereau de caisse). */
      reference: line(100),
    }),
    /** Montant dû avant ce paiement. */
    dueBefore: amount,
    /** Décomposition facultative du montant dû avant ce paiement ; sa somme égale `dueBefore`. */
    dueBreakdown: z.strictObject({ costs: money, interests: money, principal: money }).optional(),
    place,
  })
  .superRefine((v, ctx) => {
    if (!v.dueBreakdown) return;
    const { costs, interests, principal } = v.dueBreakdown;
    if (costs + interests + principal !== v.dueBefore) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueBreakdown'],
        message: 'La décomposition doit être égale au montant dû avant le paiement.',
      });
    }
  });

type Parts = { costs: number; interests: number; principal: number };

/** Imputation d'un paiement : frais, puis intérêts, puis principal (R-EN-03). */
function allocate(paid: number, due: Parts): { applied: Parts; remaining: Parts } {
  let left = paid;
  const take = (owed: number) => {
    const part = Math.min(left, owed);
    left -= part;
    return part;
  };
  const applied = { costs: take(due.costs), interests: take(due.interests), principal: take(due.principal) };
  return {
    applied,
    remaining: {
      costs: due.costs - applied.costs,
      interests: due.interests - applied.interests,
      principal: due.principal - applied.principal,
    },
  };
}

export type RecoveryReceiptV1 = z.infer<typeof schema>;

export const recoveryReceiptV1: DocumentTemplate<RecoveryReceiptV1> = {
  code: 'recovery_receipt',
  version: 1,
  numberPrefix: 'RCU',
  signature: 'none',
  services: ['recovery'],
  schema,
  title: () => 'Reçu de paiement',
  place: (v) => v.place,
  build: (v, { issuer, timeZone }) => {
    const paid = v.payment.amount;
    const dueAfter = Math.max(0, v.dueBefore - paid);
    const overpaid = Math.max(0, paid - v.dueBefore);

    const rows: [string, string][] = [
      ['Reçu de', v.payer.name],
      ['Pour le compte de', v.creditor.name],
      ['Dossier', v.caseReference],
      ['Date de réception', formatDateTime(new Date(v.payment.paidAt), timeZone)],
      ['Moyen de paiement', METHOD[v.payment.method]],
      ['Référence', v.payment.reference],
      ['Montant reçu', formatAmount(paid)],
    ];
    const blocks: Block[] = [
      { kind: 'fields', rows },
      {
        kind: 'paragraph',
        text:
          `${issuer.name}, mandataire de ${v.creditor.name}, reconnaît avoir reçu de ${v.payer.name} ` +
          `la somme de ${formatAmount(paid)} au titre du dossier ${v.caseReference}.`,
      },
    ];
    const due = v.dueBreakdown;
    if (due) {
      const { applied, remaining } = allocate(paid, due);
      blocks.push(
        { kind: 'heading', text: 'Imputation du paiement' },
        {
          kind: 'paragraph',
          text: 'Le paiement est imputé d’abord sur les frais, puis sur les intérêts, puis sur le principal.',
        },
        {
          kind: 'table',
          columns: ['Poste', 'Dû avant', 'Imputé', 'Reste dû'],
          align: ['left', 'right', 'right', 'right'],
          rows: (
            [
              ['Frais de procédure', 'costs'],
              ['Intérêts et pénalités', 'interests'],
              ['Principal', 'principal'],
            ] as const
          ).map(([label, key]) => [
            label,
            formatAmount(due[key]),
            formatAmount(applied[key]),
            formatAmount(remaining[key]),
          ]),
          totalRow: [
            'Total',
            formatAmount(v.dueBefore),
            formatAmount(Math.min(paid, v.dueBefore)),
            formatAmount(dueAfter),
          ],
        },
      );
    }
    blocks.push({
      kind: 'fields',
      rows: [
        ['Montant dû avant ce paiement', formatAmount(v.dueBefore)],
        ['Reste dû', formatAmount(dueAfter)],
      ],
    });
    if (dueAfter === 0) {
      blocks.push({
        kind: 'paragraph',
        strong: true,
        text: 'Le montant dû est entièrement réglé. Une attestation de solde vous sera adressée.',
      });
    } else {
      blocks.push({
        kind: 'paragraph',
        text: 'Ce reçu atteste le paiement ci-dessus ; il ne vaut pas quittance du solde restant dû.',
      });
    }
    if (overpaid > 0) {
      blocks.push({
        kind: 'paragraph',
        text:
          `Le paiement dépasse le montant dû de ${formatAmount(overpaid)}. Cette somme vous sera ` +
          'remboursée après vérification par notre service financier.',
      });
    }
    return blocks;
  },
};
