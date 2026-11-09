import { z } from 'zod';
import { formatAmount, formatCalendarDate } from '../format';
import { amount, calendarDate, type DocumentTemplate, line, phone, place, reference, text } from './template';

/**
 * Protocole d'accord et échéancier, version 1 : le débiteur reconnaît sa dette et s'engage sur un
 * échéancier ; signé en ligne par le débiteur (sans compte KSP) avec un code reçu sur son
 * téléphone (ADR-044). Texte sobre et générique, à faire valider par un juriste (ADR-044).
 */
const installment = z.strictObject({ dueDate: calendarDate, amount });

const schema = z
  .strictObject({
    caseReference: reference,
    creditor: z.strictObject({ name: line(200) }),
    debtor: z.strictObject({
      name: line(200),
      address: line(300).optional(),
      /** Numéro de pièce d'identité, IFU ou RCCM. */
      identification: line(100).optional(),
      phoneE164: phone.optional(),
    }),
    claim: z.strictObject({ cause: text(1000) }),
    /** Somme reconnue et due selon l'échéancier : égale à la somme des échéances. */
    agreedTotal: amount,
    installments: z.array(installment).min(1).max(60),
    paymentInstructions: text(500),
    /** Délai de régularisation d'une échéance impayée après rappel, avant déchéance du terme. */
    graceDays: z.int().min(1).max(30).default(8),
    place,
  })
  .superRefine((v, ctx) => {
    const sum = v.installments.reduce((total, item) => total + item.amount, 0);
    if (sum !== v.agreedTotal) {
      ctx.addIssue({
        code: 'custom',
        path: ['installments'],
        message: 'La somme des échéances doit être égale au total convenu.',
      });
    }
    v.installments.forEach((item, index) => {
      const previous = v.installments[index - 1];
      if (previous && item.dueDate <= previous.dueDate) {
        ctx.addIssue({
          code: 'custom',
          path: ['installments', index, 'dueDate'],
          message: 'Les échéances doivent se suivre dans le temps.',
        });
      }
    });
  });

export type RecoverySettlementAgreementV1 = z.infer<typeof schema>;

export const recoverySettlementAgreementV1: DocumentTemplate<RecoverySettlementAgreementV1> = {
  code: 'recovery_settlement_agreement',
  version: 1,
  numberPrefix: 'PAC',
  signature: 'required',
  services: ['recovery'],
  schema,
  title: () => 'Protocole d’accord et échéancier de paiement',
  place: (v) => v.place,
  build: (v, { issuer }) => {
    const debtor: [string, string][] = [['Nom', v.debtor.name]];
    if (v.debtor.identification) debtor.push(['Identification', v.debtor.identification]);
    if (v.debtor.address) debtor.push(['Adresse', v.debtor.address]);
    if (v.debtor.phoneE164) debtor.push(['Téléphone', v.debtor.phoneE164]);

    return [
      { kind: 'heading', text: 'Entre les soussignés' },
      {
        kind: 'fields',
        rows: [
          ['Le créancier', v.creditor.name],
          ['Représenté par', `${issuer.name}, mandataire chargé du recouvrement`],
          ['Dossier', v.caseReference],
        ],
      },
      { kind: 'paragraph', text: 'Et le débiteur :' },
      { kind: 'fields', rows: debtor },
      { kind: 'heading', text: 'Reconnaissance de dette' },
      {
        kind: 'paragraph',
        text:
          `Le débiteur reconnaît devoir au créancier la somme de ${formatAmount(v.agreedTotal)} ` +
          `au titre de : ${v.claim.cause}.`,
      },
      { kind: 'heading', text: 'Échéancier' },
      {
        kind: 'paragraph',
        text: 'Le débiteur s’engage à régler cette somme selon l’échéancier suivant :',
      },
      {
        kind: 'table',
        columns: ['Échéance', 'Date', 'Montant'],
        align: ['left', 'left', 'right'],
        rows: v.installments.map((item, index) => [
          String(index + 1),
          formatCalendarDate(item.dueDate),
          formatAmount(item.amount),
        ]),
        totalRow: ['Total', '', formatAmount(v.agreedTotal)],
      },
      { kind: 'heading', text: 'Modalités de paiement' },
      { kind: 'paragraph', text: v.paymentInstructions },
      { kind: 'heading', text: 'Respect de l’accord' },
      {
        kind: 'paragraph',
        text:
          'Tant que l’échéancier est respecté, le créancier s’abstient de toute action en ' +
          'recouvrement pour cette créance. Le débiteur peut payer par anticipation, à tout moment, ' +
          'tout ou partie du solde.',
      },
      {
        kind: 'paragraph',
        text:
          'Une échéance impayée à sa date et non régularisée dans les ' +
          `${v.graceDays} jour(s) suivant un rappel rend immédiatement exigible la totalité du solde ` +
          'restant dû, et le créancier retrouve la liberté d’agir pour le recouvrer.',
      },
      { kind: 'heading', text: 'Signature électronique' },
      {
        kind: 'paragraph',
        text:
          'Le débiteur signe le présent protocole électroniquement, au moyen d’un code à usage unique ' +
          'reçu sur son téléphone. Le certificat de signature ajouté en dernière page fait partie du ' +
          'document.',
      },
      {
        kind: 'signatures',
        parties: [
          { role: 'Le débiteur', name: v.debtor.name, note: 'Signature électronique, voir le certificat' },
          { role: `Pour ${v.creditor.name}`, name: issuer.name, note: 'Mandataire chargé du recouvrement' },
        ],
      },
    ];
  },
};
