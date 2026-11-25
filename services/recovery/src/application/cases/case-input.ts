import { tryNormalizePhone } from '@ksp/platform';
import { openingAmounts } from '../../domain/amounts';
import { isLocalDay, type LocalDay } from '../../domain/calendar';
import { type ClaimNature } from '../../domain/eligibility';
import { isWholeAmount } from '../../domain/money';
import { type PlanScale, scaleProblems } from '../../domain/payment-plan';
import { RecoveryErrors, unwrap } from '../shared/errors';
import {
  type ClaimData,
  type DebtorData,
  type DebtorKind,
  type DebtorRole,
  type PriorEffortData,
  type RecoveryCaseRecord,
} from './ports';

/**
 * Saisie d'un dossier (formulaire en cinq étapes, 4.1 ; message `CaseInput` du contrat), contrôlée et
 * normalisée : bornes du contrat OpenAPI, débiteur nommé et joignable, créances exigibles, montants
 * entiers. Les téléphones sont ramenés au format E.164 (Bénin à 10 chiffres, ADR-063).
 */
export interface DebtorInputData {
  kind: string;
  role: string;
  firstNames: string;
  lastName: string;
  legalName: string;
  ifu: string;
  rccm: string;
  representativeName: string;
  phones: readonly string[];
  emails: readonly string[];
  address: string;
  communeKey: string;
}

export interface CaseInputData {
  kind: string;
  nature: string;
  debtors: readonly DebtorInputData[];
  claims: readonly { reference: string; amount: number | null; dueDate: string; description: string }[];
  interests: number | null;
  alreadyPaid: number | null;
  priorEffort: {
    remindersCount: number;
    lastReminderDate: string;
    channels: readonly string[];
    debtAcknowledged: boolean;
    acknowledgmentFileId: string;
    promisesReceived: string;
    preserveRelationship: boolean;
  } | null;
  planScale: PlanScale | null;
  evidenceFileIds: readonly string[];
}

export type DebtorContent = Omit<DebtorData, 'id' | 'contacts'> & { phones: string[]; emails: string[] };

/** Saisie contrôlée : prête à remplir un dossier. */
export interface CaseContent {
  kind: 'b2b' | 'b2c';
  nature: ClaimNature;
  debtors: DebtorContent[];
  claims: {
    reference: string;
    nature: ClaimNature;
    principal: number;
    dueDate: LocalDay;
    description: string | null;
  }[];
  interests: number;
  alreadyPaid: number;
  priorEffort: PriorEffortData;
  preserveRelationship: boolean;
  planScale: PlanScale | null;
  evidenceFileIds: string[];
}

export const NATURES: readonly ClaimNature[] = [
  'unpaid_invoice',
  'loan',
  'acknowledgment_of_debt',
  'bounced_cheque',
  'service',
  'sale',
  'rent',
  'other',
];
const ROLES: readonly DebtorRole[] = ['main', 'co_debtor', 'guarantor'];
const CHANNELS = ['phone', 'sms', 'whatsapp', 'email', 'letter', 'visit'] as const;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMUNE_KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;

const MAX_DEBTORS = 10;
const MAX_CLAIMS = 200;
const MAX_CONTACTS = 5;
export const MAX_EVIDENCE = 20;

/** Texte facultatif borné : vide → null. */
function optionalText(field: string, value: string | undefined, max: number): string | null {
  const text = value?.trim() ?? '';
  if (text.length > max) throw RecoveryErrors.invalid(field, `${max} caractères au plus.`);
  return text || null;
}

function requiredText(field: string, value: string | undefined, max: number, message: string): string {
  const text = optionalText(field, value, max);
  if (text === null) throw RecoveryErrors.invalid(field, message);
  return text;
}

function amount(field: string, value: number | null, minimum: number): number {
  const result = value ?? 0;
  if (!isWholeAmount(result) || result < minimum) {
    throw RecoveryErrors.invalid(
      field,
      minimum > 0 ? 'Montant entier positif attendu.' : 'Montant entier attendu.',
    );
  }
  return result;
}

function pastDay(field: string, value: string, today: LocalDay, message: string): LocalDay {
  const day = value.trim();
  if (!isLocalDay(day)) throw RecoveryErrors.invalid(field, 'Date AAAA-MM-JJ attendue.');
  if (day > today) throw RecoveryErrors.invalid(field, message);
  return day;
}

function uuid(field: string, value: string): string {
  if (!UUID.test(value)) throw RecoveryErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

function debtorFrom(input: DebtorInputData, index: number): DebtorContent {
  const at = `debtors[${index}]`;
  if (input.kind !== 'person' && input.kind !== 'company') {
    throw RecoveryErrors.invalid(`${at}.kind`, 'Valeur attendue : person, company.');
  }
  const kind: DebtorKind = input.kind;
  const role = (input.role || 'main') as DebtorRole;
  if (!ROLES.includes(role))
    throw RecoveryErrors.invalid(`${at}.role`, `Valeur attendue : ${ROLES.join(', ')}.`);
  const lastName = optionalText(`${at}.lastName`, input.lastName, 100);
  const legalName = optionalText(`${at}.legalName`, input.legalName, 200);
  if (kind === 'person' && lastName === null) {
    throw RecoveryErrors.invalid(`${at}.lastName`, 'Nom du débiteur obligatoire.');
  }
  if (kind === 'company' && legalName === null) {
    throw RecoveryErrors.invalid(`${at}.legalName`, 'Raison sociale du débiteur obligatoire.');
  }
  if (input.phones.length > MAX_CONTACTS || input.emails.length > MAX_CONTACTS) {
    throw RecoveryErrors.invalid(
      `${at}.phones`,
      `${MAX_CONTACTS} téléphones et ${MAX_CONTACTS} e-mails au plus.`,
    );
  }
  const phones = [
    ...new Set(
      input.phones.map((raw, i) => {
        const phone = tryNormalizePhone(raw);
        if (phone === null)
          throw RecoveryErrors.invalid(`${at}.phones[${i}]`, 'Téléphone E.164 attendu (+229…).');
        return phone;
      }),
    ),
  ];
  const emails = [
    ...new Set(
      input.emails.map((raw, i) => {
        const email = raw.normalize('NFKC').trim().toLowerCase();
        if (!EMAIL.test(email) || email.length > 254) {
          throw RecoveryErrors.invalid(`${at}.emails[${i}]`, 'Adresse e-mail invalide.');
        }
        return email;
      }),
    ),
  ];
  if (phones.length === 0 && emails.length === 0) {
    throw RecoveryErrors.invalid(`${at}.phones`, 'Au moins un téléphone ou un e-mail du débiteur.');
  }
  const communeKey = optionalText(`${at}.communeKey`, input.communeKey, 60);
  if (communeKey !== null && !COMMUNE_KEY.test(communeKey)) {
    throw RecoveryErrors.invalid(`${at}.communeKey`, 'Clé de commune invalide.');
  }
  return {
    kind,
    role,
    firstNames: kind === 'person' ? optionalText(`${at}.firstNames`, input.firstNames, 100) : null,
    lastName: kind === 'person' ? lastName : null,
    legalName: kind === 'company' ? legalName : null,
    ifu: kind === 'company' ? optionalText(`${at}.ifu`, input.ifu, 20) : null,
    rccm: kind === 'company' ? optionalText(`${at}.rccm`, input.rccm, 40) : null,
    representativeName:
      kind === 'company' ? optionalText(`${at}.representativeName`, input.representativeName, 200) : null,
    address: optionalText(`${at}.address`, input.address, 300),
    communeKey,
    phones,
    emails,
  };
}

/** Barème saisi : bornes du contrat. */
export function scaleFrom(field: string, scale: PlanScale): PlanScale {
  const problems = scaleProblems(scale);
  if (problems.length > 0) throw RecoveryErrors.invalid(field, problems.join(' ; '));
  return { ...scale };
}

/**
 * Contrôle d'une saisie du formulaire : au moins un justificatif (un brouillon issu d'un import reçoit
 * ses pièces plus tard, exigées avant le mandat). Les loyers suivent la procédure locative du lot G :
 * refusés ici tant qu'aucun dossier de loyers ne peut être accepté.
 */
export function caseContentFrom(input: CaseInputData, today: LocalDay): CaseContent {
  if (input.kind === 'rent') {
    throw RecoveryErrors.invalid(
      'kind',
      'Les dossiers de loyers impayés arrivent avec la gestion locative : choisissez b2b ou b2c.',
    );
  }
  if (input.kind !== 'b2b' && input.kind !== 'b2c')
    throw RecoveryErrors.invalid('kind', 'Valeur attendue : b2b, b2c.');
  const nature = input.nature as ClaimNature;
  if (!NATURES.includes(nature))
    throw RecoveryErrors.invalid('nature', `Valeur attendue : ${NATURES.join(', ')}.`);
  if (input.debtors.length < 1 || input.debtors.length > MAX_DEBTORS) {
    throw RecoveryErrors.invalid('debtors', `De 1 à ${MAX_DEBTORS} débiteurs.`);
  }
  const debtors = input.debtors.map(debtorFrom);
  if (debtors.filter((debtor) => debtor.role === 'main').length !== 1) {
    throw RecoveryErrors.invalid('debtors', 'Un débiteur principal, et un seul.');
  }
  // Le débiteur principal en premier : il donne son nom à la liste et sa commune à la tarification.
  debtors.sort((a, b) => Number(b.role === 'main') - Number(a.role === 'main'));
  if (input.claims.length < 1 || input.claims.length > MAX_CLAIMS) {
    throw RecoveryErrors.invalid('claims', `De 1 à ${MAX_CLAIMS} créances.`);
  }
  const references = new Set<string>();
  const claims = input.claims.map((claim, index) => {
    const at = `claims[${index}]`;
    const reference = requiredText(`${at}.reference`, claim.reference, 60, 'Référence obligatoire.');
    const key = reference.toLowerCase();
    if (references.has(key)) throw RecoveryErrors.invalid(`${at}.reference`, 'Référence en double.');
    references.add(key);
    return {
      reference,
      nature,
      principal: amount(`${at}.amount`, claim.amount, 1),
      dueDate: pastDay(`${at}.dueDate`, claim.dueDate, today, 'La date d’exigibilité doit être atteinte.'),
      description: optionalText(`${at}.description`, claim.description, 300),
    };
  });
  const interests = amount('interests', input.interests, 0);
  const alreadyPaid = amount('alreadyPaid', input.alreadyPaid, 0);
  const principal = claims.reduce((sum, claim) => sum + claim.principal, 0);
  unwrap(openingAmounts(principal, interests, alreadyPaid));
  const effort = input.priorEffort;
  if (!effort)
    throw RecoveryErrors.invalid('priorEffort', 'Démarches déjà faites obligatoires (« aucune » acceptée).');
  if (
    !Number.isSafeInteger(effort.remindersCount) ||
    effort.remindersCount < 0 ||
    effort.remindersCount > 1000
  ) {
    throw RecoveryErrors.invalid('priorEffort.remindersCount', 'Nombre de relances de 0 à 1 000.');
  }
  const channels = [...new Set(effort.channels)];
  for (const [index, channel] of channels.entries()) {
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw RecoveryErrors.invalid(
        `priorEffort.channels[${index}]`,
        `Valeur attendue : ${CHANNELS.join(', ')}.`,
      );
    }
  }
  if (input.evidenceFileIds.length > MAX_EVIDENCE) {
    throw RecoveryErrors.invalid('evidenceFileIds', `${MAX_EVIDENCE} pièces au plus.`);
  }
  const evidenceFileIds = [
    ...new Set(input.evidenceFileIds.map((id, index) => uuid(`evidenceFileIds[${index}]`, id))),
  ];
  if (evidenceFileIds.length === 0) {
    throw RecoveryErrors.invalid('evidenceFileIds', 'Au moins une pièce prouvant la créance.');
  }
  return {
    kind: input.kind,
    nature,
    debtors,
    claims,
    interests,
    alreadyPaid,
    priorEffort: {
      remindersCount: effort.remindersCount,
      lastReminderDate: effort.lastReminderDate
        ? pastDay(
            'priorEffort.lastReminderDate',
            effort.lastReminderDate,
            today,
            'Date de relance passée attendue.',
          )
        : null,
      channels,
      acknowledged: effort.debtAcknowledged,
      acknowledgmentFileId: effort.acknowledgmentFileId
        ? uuid('priorEffort.acknowledgmentFileId', effort.acknowledgmentFileId)
        : null,
      promises: optionalText('priorEffort.promisesReceived', effort.promisesReceived, 1000),
    },
    preserveRelationship: effort.preserveRelationship,
    planScale: input.planScale ? scaleFrom('planScale', input.planScale) : null,
    evidenceFileIds,
  };
}

/**
 * Remplit un dossier avec une saisie : débiteurs et contacts (le premier téléphone et le premier
 * e-mail sont principaux), créances, montants (R-SD-08), échéance la plus ancienne. Les paiements déjà
 * reçus sont répartis sur les créances, de la plus ancienne à la plus récente.
 */
export function withContent(
  record: RecoveryCaseRecord,
  content: Omit<CaseContent, 'evidenceFileIds'>,
  nextId: () => string,
): RecoveryCaseRecord {
  const debtors: DebtorData[] = content.debtors.map((debtor) => {
    const { phones, emails, ...identity } = debtor;
    return {
      ...identity,
      id: nextId(),
      contacts: [
        ...phones.map((value, index) => ({
          id: nextId(),
          channel: 'phone' as const,
          value,
          isPrimary: index === 0,
          valid: true,
        })),
        ...emails.map((value, index) => ({
          id: nextId(),
          channel: 'email' as const,
          value,
          isPrimary: index === 0,
          valid: true,
        })),
      ],
    };
  });
  const ordered = [...content.claims].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  let toAllocate = content.alreadyPaid;
  const paidBefore = new Map<string, number>();
  for (const [index, claim] of ordered.entries()) {
    const part = index === ordered.length - 1 ? toAllocate : Math.min(toAllocate, claim.principal);
    paidBefore.set(claim.reference, part);
    toAllocate -= part;
  }
  const claims: ClaimData[] = content.claims.map((claim) => ({
    id: nextId(),
    reference: claim.reference,
    nature: claim.nature,
    principal: claim.principal,
    dueDate: claim.dueDate,
    description: claim.description,
    paidBefore: paidBefore.get(claim.reference) ?? 0,
  }));
  return {
    ...record,
    kind: content.kind,
    nature: content.nature,
    debtors,
    claims,
    principal: claims.reduce((sum, claim) => sum + claim.principal, 0),
    interests: content.interests,
    paid: content.alreadyPaid,
    earliestDueDate: ordered[0]?.dueDate ?? null,
    communeKey: debtors[0]?.communeKey ?? null,
    priorEffort: content.priorEffort,
    preserveRelationship: content.preserveRelationship,
    planScale: content.planScale ?? record.planScale,
  };
}
