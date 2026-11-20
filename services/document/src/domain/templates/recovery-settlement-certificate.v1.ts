import { z } from 'zod';
import { type Block } from '../content';
import { formatAmount, formatCalendarDate } from '../format';
import { amount, calendarDate, type DocumentTemplate, line, place, reference, text } from './template';

/**
 * Attestation de solde, version 1 : remise au débiteur quand son dossier est clos, payé en entier ou
 * par l'exécution d'un accord transactionnel (R-DB-03). Jamais signée par code : KSP l'émet.
 * À faire relire par l'avocat : portée de l'attestation (quittance du créancier ou simple constat du
 * mandataire) et mention de la remise consentie dans un accord transactionnel.
 */
const payment = z.strictObject({ date: calendarDate, amount });

const schema = z
  .strictObject({
    caseReference: reference,
    creditor: z.strictObject({ name: line(200) }),
    debtor: z.strictObject({
      name: line(200),
      address: line(300).optional(),
      /** Numéro de pièce d'identité, IFU ou RCCM. */
      identification: line(100).optional(),
    }),
    claim: z.strictObject({ cause: text(1000) }),
    /** `paid_in_full` : montant dû réglé ; `settlement_executed` : accord transactionnel exécuté. */
    closure: z.enum(['paid_in_full', 'settlement_executed']),
    /** Somme totale reçue au titre du dossier. */
    totalPaid: amount,
    /** Solde abandonné par le créancier dans l'accord transactionnel (seulement dans ce cas). */
    waivedAmount: amount.optional(),
    /** Date à laquelle le dossier est soldé. */
    settledOn: calendarDate,
    /** Détail facultatif des paiements reçus : leur somme égale `totalPaid`. */
    payments: z.array(payment).min(1).max(240).optional(),
    place,
  })
  .superRefine((v, ctx) => {
    if (v.closure === 'settlement_executed' && v.waivedAmount === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['waivedAmount'],
        message: 'Le solde abandonné est requis pour un accord transactionnel.',
      });
    }
    if (v.closure === 'paid_in_full' && v.waivedAmount !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['waivedAmount'],
        message: 'Aucun solde abandonné pour un dossier payé en entier.',
      });
    }
    if (!v.payments) return;
    const sum = v.payments.reduce((total, item) => total + item.amount, 0);
    if (sum !== v.totalPaid) {
      ctx.addIssue({
        code: 'custom',
        path: ['payments'],
        message: 'La somme des paiements doit être égale au total reçu.',
      });
    }
    v.payments.forEach((item, index) => {
      const previous = v.payments![index - 1];
      if (previous && item.date < previous.date) {
        ctx.addIssue({
          code: 'custom',
          path: ['payments', index, 'date'],
          message: 'Les paiements doivent être dans l’ordre des dates.',
        });
      }
      if (item.date > v.settledOn) {
        ctx.addIssue({
          code: 'custom',
          path: ['payments', index, 'date'],
          message: 'Un paiement ne peut pas suivre la date de solde.',
        });
      }
    });
  });

export type RecoverySettlementCertificateV1 = z.infer<typeof schema>;

export const recoverySettlementCertificateV1: DocumentTemplate<RecoverySettlementCertificateV1> = {
  code: 'recovery_settlement_certificate',
  version: 1,
  numberPrefix: 'ATS',
  signature: 'none',
  services: ['recovery'],
  schema,
  title: () => 'Attestation de solde',
  place: (v) => v.place,
  build: (v, { issuer }) => {
    const debtor: [string, string][] = [['Débiteur', v.debtor.name]];
    if (v.debtor.identification) debtor.push(['Identification', v.debtor.identification]);
    if (v.debtor.address) debtor.push(['Adresse', v.debtor.address]);
    debtor.push(['Créancier', v.creditor.name], ['Dossier', v.caseReference]);

    const settled = formatCalendarDate(v.settledOn);
    const conclusion =
      v.closure === 'paid_in_full'
        ? `Le montant dû au titre de ce dossier a été intégralement réglé. Le dossier est soldé au ${settled}.`
        : 'Les paiements prévus par l’accord transactionnel conclu avec le créancier ont été intégralement ' +
          `exécutés. Conformément à cet accord, le créancier a renoncé au solde de ` +
          `${formatAmount(v.waivedAmount ?? 0)}. Le dossier est soldé au ${settled}.`;

    const blocks: Block[] = [
      { kind: 'fields', rows: debtor },
      {
        kind: 'paragraph',
        text:
          `${issuer.name}, agissant en qualité de mandataire de ${v.creditor.name} pour le ` +
          `recouvrement de la créance ci-dessous, atteste que ${v.debtor.name} a réglé la somme ` +
          `totale de ${formatAmount(v.totalPaid)} au titre de : ${v.claim.cause}.`,
      },
      { kind: 'paragraph', strong: true, text: conclusion },
    ];
    if (v.payments) {
      blocks.push(
        { kind: 'heading', text: 'Paiements reçus' },
        {
          kind: 'table',
          columns: ['N°', 'Date', 'Montant'],
          align: ['left', 'left', 'right'],
          rows: v.payments.map((item, index) => [
            String(index + 1),
            formatCalendarDate(item.date),
            formatAmount(item.amount),
          ]),
          totalRow: ['Total', '', formatAmount(v.totalPaid)],
        },
      );
    }
    blocks.push(
      {
        kind: 'paragraph',
        text:
          'En conséquence, plus aucune somme n’est réclamée au débiteur au titre de ce dossier. ' +
          'La présente attestation est délivrée pour servir et valoir ce que de droit.',
      },
      {
        kind: 'signatures',
        parties: [
          {
            role: `Pour ${v.creditor.name}`,
            name: issuer.name,
            note: 'Mandataire chargé du recouvrement',
          },
        ],
      },
    );
    return blocks;
  },
};
