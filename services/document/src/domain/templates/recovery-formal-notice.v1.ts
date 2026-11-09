import { z } from 'zod';
import { addDays, formatAmount, formatCalendarDate, formatLongDate } from '../format';
import { amount, calendarDate, type DocumentTemplate, line, phone, place, reference, text } from './template';

/**
 * Mise en demeure de payer, version 1 : adressée au débiteur par KSP au nom du créancier, en vertu
 * du mandat de recouvrement. Jamais signée par code : elle est envoyée (ADR-044).
 * Texte sobre et générique, à faire valider par un juriste avant la production (ADR-044).
 */
const schema = z.strictObject({
  caseReference: reference,
  creditor: z.strictObject({ name: line(200) }),
  debtor: z.strictObject({
    name: line(200),
    address: line(300).optional(),
  }),
  claim: z.strictObject({
    principal: amount,
    cause: text(1000),
    dueDate: calendarDate.optional(),
    /** Intérêts et frais réclamés en plus du principal, en FCFA. */
    additionalCharges: z.int().min(0).max(100_000_000_000).optional(),
  }),
  /** Délai de paiement accordé, en jours à compter de la date du document. */
  paymentDeadlineDays: z.int().min(1).max(60),
  /** Comment payer (Mobile Money, virement, agence…). */
  paymentInstructions: text(500),
  /** Numéro à joindre pour convenir d'un échéancier. */
  contactPhoneE164: phone.optional(),
  place,
});

export type RecoveryFormalNoticeV1 = z.infer<typeof schema>;

export const recoveryFormalNoticeV1: DocumentTemplate<RecoveryFormalNoticeV1> = {
  code: 'recovery_formal_notice',
  version: 1,
  numberPrefix: 'MED',
  signature: 'none',
  services: ['recovery'],
  schema,
  title: () => 'Mise en demeure de payer',
  place: (v) => v.place,
  build: (v, { issuedAt, timeZone, issuer }) => {
    const total = v.claim.principal + (v.claim.additionalCharges ?? 0);
    const deadline = formatLongDate(addDays(issuedAt, v.paymentDeadlineDays), timeZone);
    const addressee: [string, string][] = [['Destinataire', v.debtor.name]];
    if (v.debtor.address) addressee.push(['Adresse', v.debtor.address]);
    addressee.push(['Créancier', v.creditor.name], ['Dossier', v.caseReference]);

    const amounts: [string, string][] = [['Principal', formatAmount(v.claim.principal)]];
    if (v.claim.additionalCharges) {
      amounts.push(['Intérêts et frais', formatAmount(v.claim.additionalCharges)]);
    }
    amounts.push(['Total à régler', formatAmount(total)]);

    const due = v.claim.dueDate ? `, échue le ${formatCalendarDate(v.claim.dueDate)}` : '';
    return [
      { kind: 'fields', rows: addressee },
      { kind: 'paragraph', text: 'Madame, Monsieur,' },
      {
        kind: 'paragraph',
        text:
          `Agissant pour le compte de ${v.creditor.name}, en vertu du mandat de recouvrement qu’il ` +
          `nous a confié, nous vous rappelons que vous restez redevable de la somme de ` +
          `${formatAmount(v.claim.principal)} au titre de : ${v.claim.cause}${due}. ` +
          'Malgré les relances, cette somme demeure impayée.',
      },
      { kind: 'fields', rows: amounts },
      {
        kind: 'paragraph',
        strong: true,
        text:
          `Par la présente, nous vous mettons en demeure de régler la somme de ${formatAmount(total)} ` +
          `dans un délai de ${v.paymentDeadlineDays} jour(s), soit au plus tard le ${deadline}.`,
      },
      { kind: 'heading', text: 'Modalités de paiement' },
      { kind: 'paragraph', text: v.paymentInstructions },
      {
        kind: 'paragraph',
        text:
          'Si vous rencontrez des difficultés, contactez-nous avant cette date pour convenir d’un ' +
          `échéancier${v.contactPhoneE164 ? ` au ${v.contactPhoneE164}` : ''}.`,
      },
      {
        kind: 'paragraph',
        text:
          'À défaut de règlement ou d’accord dans ce délai, le créancier se réserve le droit ' +
          'd’engager toute procédure utile au recouvrement de sa créance, sans nouvel avis.',
      },
      {
        kind: 'paragraph',
        text: 'Veuillez agréer, Madame, Monsieur, l’expression de nos salutations distinguées.',
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
    ];
  },
};
