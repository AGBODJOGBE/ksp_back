import { z } from 'zod';
import { formatAmount, formatCalendarDate, formatPercent } from '../format';
import { amount, calendarDate, type DocumentTemplate, line, phone, place, reference, text } from './template';

/**
 * Mandat de recouvrement amiable, version 1 : le créancier (mandant) confie à KSP (mandataire) le
 * recouvrement d'une créance ; signé en ligne par le créancier avec un code (ADR-044).
 * Texte sobre et générique, à faire valider par un juriste avant la production (ADR-044).
 */
const schema = z.strictObject({
  caseReference: reference,
  creditor: z.strictObject({
    name: line(200),
    kind: z.enum(['individual', 'company']),
    /** IFU, RCCM ou numéro de pièce d'identité. */
    identification: line(100).optional(),
    address: line(300),
    phoneE164: phone.optional(),
    email: z.email().max(254).optional(),
    /** Personne morale : représentant et sa qualité. */
    representative: line(200).optional(),
  }),
  debtor: z.strictObject({
    name: line(200),
    address: line(300).optional(),
    phoneE164: phone.optional(),
  }),
  claim: z.strictObject({
    principal: amount,
    cause: text(1000),
    dueDate: calendarDate.optional(),
    /** Nombre de pièces justificatives transmises. */
    evidenceCount: z.int().min(0).max(500).optional(),
  }),
  fees: z.strictObject({
    /** Honoraires de résultat, en pourcentage des sommes recouvrées (0 à 50, une décimale). */
    successFeePercent: z
      .number()
      .min(0)
      .max(50)
      .refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, 'Une décimale au plus.'),
    /** Frais de dossier fixes, en FCFA. */
    fixedFee: z.int().min(0).max(100_000_000).optional(),
  }),
  durationMonths: z.int().min(1).max(36),
  place,
});

export type RecoveryMandateV1 = z.infer<typeof schema>;

export const recoveryMandateV1: DocumentTemplate<RecoveryMandateV1> = {
  code: 'recovery_mandate',
  version: 1,
  numberPrefix: 'MAN',
  signature: 'required',
  services: ['recovery'],
  schema,
  title: () => 'Mandat de recouvrement',
  place: (v) => v.place,
  build: (v, { issuer }) => {
    const creditor: [string, string][] = [
      ['Nom', v.creditor.name],
      ['Qualité', v.creditor.kind === 'company' ? 'Personne morale' : 'Personne physique'],
    ];
    if (v.creditor.representative) creditor.push(['Représenté par', v.creditor.representative]);
    if (v.creditor.identification) creditor.push(['Identification', v.creditor.identification]);
    creditor.push(['Adresse', v.creditor.address]);
    if (v.creditor.phoneE164) creditor.push(['Téléphone', v.creditor.phoneE164]);
    if (v.creditor.email) creditor.push(['E-mail', v.creditor.email]);

    const debtor: [string, string][] = [['Nom', v.debtor.name]];
    if (v.debtor.address) debtor.push(['Adresse', v.debtor.address]);
    if (v.debtor.phoneE164) debtor.push(['Téléphone', v.debtor.phoneE164]);

    const claim: [string, string][] = [
      ['Dossier', v.caseReference],
      ['Montant principal', formatAmount(v.claim.principal)],
      ['Cause', v.claim.cause],
    ];
    if (v.claim.dueDate) claim.push(['Échéance', formatCalendarDate(v.claim.dueDate)]);
    if (v.claim.evidenceCount !== undefined) {
      claim.push(['Pièces justificatives', `${v.claim.evidenceCount} pièce(s) transmise(s)`]);
    }

    const fees = [
      `Honoraires de résultat : ${formatPercent(v.fees.successFeePercent)} des sommes effectivement ` +
        'recouvrées, dus au fur et à mesure des encaissements.',
    ];
    if (v.fees.fixedFee) fees.push(`Frais de dossier : ${formatAmount(v.fees.fixedFee)}.`);
    fees.push('Aucune autre somme ne peut être réclamée au mandant sans son accord écrit préalable.');

    return [
      { kind: 'heading', text: 'Le mandant (créancier)' },
      { kind: 'fields', rows: creditor },
      { kind: 'heading', text: 'Le mandataire' },
      {
        kind: 'fields',
        rows: [
          ['Nom', issuer.name],
          ['Adresse', issuer.address],
        ],
      },
      { kind: 'heading', text: 'Objet du mandat' },
      {
        kind: 'paragraph',
        text:
          'Le mandant confie au mandataire, qui l’accepte, le recouvrement amiable de la créance ' +
          'décrite ci-dessous, qu’il détient sur le débiteur désigné. Le mandataire agit au nom et ' +
          'pour le compte du mandant.',
      },
      { kind: 'heading', text: 'Le débiteur' },
      { kind: 'fields', rows: debtor },
      { kind: 'heading', text: 'La créance' },
      { kind: 'fields', rows: claim },
      { kind: 'heading', text: 'Missions du mandataire' },
      {
        kind: 'list',
        items: [
          'relancer le débiteur par téléphone, message, courrier ou visite ;',
          'lui adresser une mise en demeure au nom du mandant ;',
          'négocier un échéancier de paiement, soumis à l’accord du mandant ;',
          'tenir le mandant informé de l’avancement du dossier dans son espace KSP.',
        ],
      },
      { kind: 'heading', text: 'Rémunération' },
      { kind: 'list', items: fees },
      { kind: 'heading', text: 'Durée et fin du mandat' },
      {
        kind: 'paragraph',
        text:
          `Le présent mandat est conclu pour une durée de ${v.durationMonths} mois à compter de sa ` +
          'signature. Chaque partie peut y mettre fin à tout moment par écrit ; les honoraires restent ' +
          'dus sur les sommes recouvrées avant la fin du mandat.',
      },
      { kind: 'heading', text: 'Engagements du mandant' },
      {
        kind: 'paragraph',
        text:
          'Le mandant certifie que la créance est réelle et exigible, et que les informations et ' +
          'pièces transmises sont exactes. Il informe sans délai le mandataire de tout paiement ou ' +
          'accord intervenu directement avec le débiteur.',
      },
      { kind: 'heading', text: 'Signature électronique' },
      {
        kind: 'paragraph',
        text:
          'Le mandant signe le présent mandat électroniquement, au moyen d’un code à usage unique ' +
          'reçu sur son téléphone ou par e-mail. Le certificat de signature ajouté en dernière page ' +
          'fait partie du document.',
      },
      {
        kind: 'signatures',
        parties: [
          { role: 'Le mandant', name: v.creditor.name, note: 'Signature électronique, voir le certificat' },
          { role: 'Le mandataire', name: issuer.name, note: 'Mandat accepté' },
        ],
      },
    ];
  },
};
