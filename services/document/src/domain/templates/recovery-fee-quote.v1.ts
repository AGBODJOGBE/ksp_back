import { z } from 'zod';
import { formatAmount, formatCalendarDate } from '../format';
import { amount, calendarDate, type DocumentTemplate, line, place, reference } from './template';

/**
 * Devis des frais de procédure, version 1 : soumis au créancier avant de confier le dossier à un
 * huissier (étape 5) ou d'engager une procédure judiciaire (étape 6). Le créancier l'accepte en
 * ligne et paie la provision (R-PR-04) ; la signature par code est possible, jamais exigée.
 * KSP n'avance aucun frais : un dépassement donne lieu à une provision complémentaire, soumise à
 * l'accord du créancier.
 * À faire relire par l'avocat : nature des frais refacturables, sort des frais mis à la charge du
 * débiteur par le juge (R-CO-06), effet de l'absence d'accord dans le délai.
 */
const feeLine = z.strictObject({
  category: z.enum(['bailiff', 'court_registry', 'lawyer', 'other']),
  label: line(200),
  amount,
});

const CATEGORY: Record<z.infer<typeof feeLine>['category'], string> = {
  bailiff: 'Huissier de justice',
  court_registry: 'Greffe',
  lawyer: 'Avocat',
  other: 'Autres frais',
};

const schema = z
  .strictObject({
    caseReference: reference,
    creditor: z.strictObject({ name: line(200) }),
    debtor: z.strictObject({ name: line(200) }),
    /** Étape proposée : `bailiff` (huissier) ou `litigation` (procédure judiciaire). */
    stage: z.enum(['bailiff', 'litigation']),
    partner: z.strictObject({
      kind: z.enum(['bailiff', 'lawyer']),
      /** Nom du partenaire et de son office ou cabinet. */
      name: line(200),
      office: line(200).optional(),
    }),
    /** Montant dû au jour du devis, rappelé pour comparaison avec les frais. */
    amountDue: amount,
    lines: z.array(feeLine).min(1).max(50),
    /** Total estimé : égal à la somme des lignes. */
    total: amount,
    /** Provision demandée maintenant, au plus égale au total. */
    provision: amount,
    /** Date limite d'accord ; au-delà, le dossier est clôturé « abandon par le créancier ». */
    acceptBy: calendarDate,
    place,
  })
  .superRefine((v, ctx) => {
    const sum = v.lines.reduce((total, item) => total + item.amount, 0);
    if (sum !== v.total) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'La somme des lignes doit être égale au total.',
      });
    }
    if (v.stage === 'bailiff' && v.partner.kind !== 'bailiff') {
      ctx.addIssue({
        code: 'custom',
        path: ['partner', 'kind'],
        message: 'L’étape huissier propose un huissier de justice.',
      });
    }
    if (v.provision > v.total) {
      ctx.addIssue({
        code: 'custom',
        path: ['provision'],
        message: 'La provision ne peut pas dépasser le total estimé.',
      });
    }
  });

export type RecoveryFeeQuoteV1 = z.infer<typeof schema>;

export const recoveryFeeQuoteV1: DocumentTemplate<RecoveryFeeQuoteV1> = {
  code: 'recovery_fee_quote',
  version: 1,
  numberPrefix: 'DEV',
  signature: 'optional',
  services: ['recovery'],
  schema,
  title: (v) =>
    v.stage === 'bailiff'
      ? 'Devis des frais : intervention d’un huissier'
      : 'Devis des frais : procédure judiciaire',
  place: (v) => v.place,
  build: (v, { issuer }) => {
    const step =
      v.stage === 'bailiff'
        ? 'confier le dossier à un huissier de justice (sommation de payer et, si nécessaire, mesures conservatoires)'
        : 'engager une procédure judiciaire (injonction de payer ou action en paiement), puis son exécution';
    const partner = v.partner.office ? `${v.partner.name}, ${v.partner.office}` : v.partner.name;

    return [
      {
        kind: 'fields',
        rows: [
          ['Créancier', v.creditor.name],
          ['Débiteur', v.debtor.name],
          ['Dossier', v.caseReference],
          ['Montant dû à ce jour', formatAmount(v.amountDue)],
          [v.partner.kind === 'bailiff' ? 'Huissier proposé' : 'Avocat proposé', partner],
        ],
      },
      {
        kind: 'paragraph',
        text:
          'Les démarches amiables n’ayant pas abouti, nous vous proposons de ' +
          `${step}. Cette étape ne démarre qu’avec votre accord et après le paiement de la provision.`,
      },
      { kind: 'heading', text: 'Frais estimés' },
      {
        kind: 'table',
        columns: ['N°', 'Nature', 'Détail', 'Montant'],
        align: ['left', 'left', 'left', 'right'],
        rows: v.lines.map((item, index) => [
          String(index + 1),
          CATEGORY[item.category],
          item.label,
          formatAmount(item.amount),
        ]),
        totalRow: ['Total', '', '', formatAmount(v.total)],
      },
      {
        kind: 'fields',
        rows: [
          ['Provision à verser', formatAmount(v.provision)],
          ['Accord attendu au plus tard le', formatCalendarDate(v.acceptBy)],
        ],
      },
      { kind: 'heading', text: 'Conditions' },
      {
        kind: 'list',
        items: [
          'Les montants sont estimés d’après le tarif applicable ou la convention d’honoraires du ' +
            'partenaire ; les frais réels vous sont justifiés acte par acte.',
          `${issuer.name} n’avance aucun frais : si les frais réels dépassent la provision, une provision ` +
            'complémentaire vous est demandée et soumise à votre accord avant toute nouvelle dépense.',
          'Les frais que le juge mettrait à la charge du débiteur, s’ils sont recouvrés, vous sont ' +
            'remboursés en priorité.',
          'La provision non utilisée vous est restituée à la clôture du dossier.',
          `Sans accord de votre part au ${formatCalendarDate(v.acceptBy)}, le dossier est clôturé ` +
            '« abandon par le créancier » ; la commission reste due sur les sommes déjà encaissées.',
        ],
      },
      {
        kind: 'signatures',
        parties: [
          {
            role: 'Bon pour accord',
            name: v.creditor.name,
            note: 'Acceptation en ligne ou signature électronique',
          },
          { role: 'Pour le mandataire', name: issuer.name, note: 'Chargé du recouvrement' },
        ],
      },
    ];
  },
};
