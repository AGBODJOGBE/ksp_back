import { tryNormalizePhone } from '@ksp/platform';
import { LEGAL_ACT_TYPES } from '../../domain/litigation';
import {
  canTransitionPartner,
  type PartnerKind,
  type PartnerProfile,
  type PartnerStatus,
  rankPartners,
} from '../../domain/partner';
import { requireCaseInScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { UUID } from '../cases/case-input';
import { requireIdempotencyKey, requirePage, stableId } from '../cases/case-rules';
import { requireCaseId } from '../cases/creditor-cases.use-cases';
import { BACKOFFICE_MFA_SECONDS, CRITICAL_MFA_SECONDS, requireStaff, type Staff } from '../shared/access';
import { RecoveryErrors } from '../shared/errors';
import { type LitigationDeps, type PartnerFeeData, type PartnerRecord } from './litigation.ports';
import { LEGAL_AND_SUPERVISORS, LEGAL_ROLES, LitigationErrors, oneLine } from './litigation-rules';
import { type PartnerView, partnerViews } from './litigation-views';

/**
 * Référentiel des huissiers et avocats partenaires (UC-RC-24, R-HU-01) et propositions pour un
 * dossier (R-HU-02). Une fiche est créée « en attente de vérification » ; elle n'est activée qu'avec la
 * pièce de vérification (nomination, inscription au barreau), par le juriste. Coordonnées
 * professionnelles chiffrées en base ; jamais dans les journaux ni les événements.
 */

const KINDS: readonly PartnerKind[] = ['bailiff', 'lawyer'];
const STATUSES: readonly PartnerStatus[] = ['pending_verification', 'active', 'suspended'];
const FEE_TYPES: readonly string[] = [...LEGAL_ACT_TYPES, 'hourly', 'flat_case'];
const COMMUNE_KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
const PARTNER_SUBJECT = (partnerId: string) => ({ type: 'recovery_partner', id: partnerId });

/** Saisie d'une fiche (`PartnerInput` du contrat). */
export interface PartnerInputData {
  kind: string;
  name: string;
  office: string;
  communeKeys: readonly string[];
  phones: readonly string[];
  email: string;
  userId: string;
  fees: readonly { actType: string; amount: number | null }[];
  verificationFileId: string;
}

type PartnerContent = Pick<
  PartnerRecord,
  'kind' | 'name' | 'office' | 'areas' | 'phones' | 'email' | 'userId' | 'fees' | 'verificationFileId'
>;

function partnerContent(input: PartnerInputData | null): PartnerContent {
  if (!input) throw RecoveryErrors.invalid('input', 'Fiche du partenaire attendue.');
  const kind = input.kind as PartnerKind;
  if (!KINDS.includes(kind)) throw RecoveryErrors.invalid('input.kind', 'Valeur attendue : bailiff, lawyer.');
  const name = oneLine(input.name ?? '', 1000);
  if (name.length < 2 || name.length > 200) {
    throw RecoveryErrors.invalid('input.name', 'Nom de 2 à 200 caractères.');
  }
  const office = oneLine(input.office ?? '', 1000);
  if (office.length > 200) throw RecoveryErrors.invalid('input.office', '200 caractères au plus.');
  const areas = [...new Set(input.communeKeys.map((key) => key.trim().toLowerCase()))];
  if (areas.length === 0 || areas.length > 100 || areas.some((key) => !COMMUNE_KEY.test(key))) {
    throw RecoveryErrors.invalid('input.communeKeys', 'De 1 à 100 clés de commune valides.');
  }
  if (input.phones.length > 5) throw RecoveryErrors.invalid('input.phones', '5 numéros au plus.');
  const phones = input.phones.map((phone) => tryNormalizePhone(phone));
  if (phones.some((phone) => phone === null)) {
    throw RecoveryErrors.invalid('input.phones', 'Numéros au format international (+229…).');
  }
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL.test(email)) throw RecoveryErrors.invalid('input.email', 'Adresse e-mail invalide.');
  const userId = input.userId?.trim().toLowerCase() || null;
  if (userId && !UUID.test(userId))
    throw RecoveryErrors.invalid('input.userId', 'Identifiant de compte invalide.');
  if (input.fees.length > 50) throw RecoveryErrors.invalid('input.fees', '50 honoraires au plus.');
  const fees: PartnerFeeData[] = input.fees.map((fee) => {
    if (!FEE_TYPES.includes(fee.actType)) {
      throw RecoveryErrors.invalid('input.fees', `Type attendu : ${FEE_TYPES.join(', ')}.`);
    }
    if (fee.amount === null || !Number.isSafeInteger(fee.amount) || fee.amount <= 0) {
      throw RecoveryErrors.invalid('input.fees', 'Honoraire entier en FCFA, strictement positif.');
    }
    return { actType: fee.actType, amount: fee.amount };
  });
  if (new Set(fees.map((fee) => fee.actType)).size !== fees.length) {
    throw RecoveryErrors.invalid('input.fees', 'Un seul honoraire par type d’acte.');
  }
  const verificationFileId = input.verificationFileId?.trim().toLowerCase() || null;
  if (verificationFileId && !UUID.test(verificationFileId)) {
    throw RecoveryErrors.invalid('input.verificationFileId', 'Identifiant de fichier invalide.');
  }
  return {
    kind,
    name,
    office: office || null,
    areas,
    phones: phones as string[],
    email,
    userId,
    fees,
    verificationFileId,
  };
}

async function requirePartner(deps: LitigationDeps, partnerId: string): Promise<PartnerRecord> {
  if (!UUID.test(partnerId ?? '')) throw LitigationErrors.partnerNotFound();
  const partner = await deps.litigation.partner(partnerId.toLowerCase());
  if (!partner) throw LitigationErrors.partnerNotFound();
  return partner;
}

async function viewOf(deps: LitigationDeps, partner: PartnerRecord): Promise<PartnerView> {
  const [view] = await partnerViews(deps, [partner]);
  return view!;
}

/** Pièce de vérification rattachée à la fiche chez file (envoyée par le juriste). */
async function attachVerification(deps: LitigationDeps, staff: Staff, partner: PartnerRecord): Promise<void> {
  if (!partner.verificationFileId) return;
  await deps.files.attach({
    fileId: partner.verificationFileId,
    subject: PARTNER_SUBJECT(partner.id),
    ownerId: staff.userId,
  });
}

/** Partenaires du référentiel (ListPartners), filtrés par métier, statut et commune couverte. */
export class ListPartnersUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: {
    kind: string;
    statuses: readonly string[];
    communeKey: string;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: PartnerView[]; nextCursor: string | null }> {
    requireStaff(LEGAL_AND_SUPERVISORS, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    const kind = (input.kind || null) as PartnerKind | null;
    if (kind && !KINDS.includes(kind))
      throw RecoveryErrors.invalid('kind', 'Valeur attendue : bailiff, lawyer.');
    const statuses = input.statuses as PartnerStatus[];
    if (statuses.some((status) => !STATUSES.includes(status))) {
      throw RecoveryErrors.invalid('statuses', `Valeurs attendues : ${STATUSES.join(', ')}.`);
    }
    const communeKey = input.communeKey?.trim().toLowerCase() || null;
    const page = await this.deps.litigation.partners({ kind, statuses, communeKey }, requirePage(input.page));
    return { items: await partnerViews(this.deps, page.items), nextCursor: page.nextCursor };
  }
}

export class GetPartnerUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: { partnerId: string }): Promise<PartnerView> {
    requireStaff(LEGAL_AND_SUPERVISORS, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    return viewOf(this.deps, await requirePartner(this.deps, input.partnerId));
  }
}

/**
 * Nouvelle fiche (CreatePartner), en attente de vérification. Rejouée avec la même clé par le même
 * juriste, elle rend la fiche créée.
 */
export class CreatePartnerUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: { idempotencyKey: string; input: PartnerInputData | null }): Promise<PartnerView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const id = stableId('recovery-partner', staff.userId, key);
    const known = await this.deps.litigation.partner(id);
    if (known) return viewOf(this.deps, known);
    const partner: PartnerRecord = {
      id,
      ...partnerContent(input.input),
      status: 'pending_verification',
      statusReason: null,
      verifiedBy: null,
      verifiedAt: null,
      createdBy: staff.userId,
      createdAt: now,
      updatedAt: now,
    };
    await attachVerification(this.deps, staff, partner);
    const outcome = await this.deps.litigation.savePartner(partner, null, {
      actorId: staff.userId,
      action: 'partner.created',
      at: now,
      details: { kind: partner.kind },
    });
    if (outcome === 'duplicate') {
      const again = await this.deps.litigation.partner(id);
      if (again) return viewOf(this.deps, again);
      throw RecoveryErrors.invalid('input.userId', 'Ce compte est déjà lié à un autre partenaire.');
    }
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate('active');
    return viewOf(this.deps, partner);
  }
}

/**
 * Modification d'une fiche (UpdatePartner) et changement de statut : activation après vérification
 * (pièce obligatoire, juriste tracé), suspension motivée, réactivation. Le métier ne change pas : un
 * huissier et un avocat sont deux fiches. Un partenaire suspendu garde ses assignations en cours, que le
 * juriste retire s'il le faut ; il n'en reçoit plus de nouvelles.
 */
export class UpdatePartnerUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: {
    partnerId: string;
    input: PartnerInputData | null;
    status: string;
    statusReason: string;
  }): Promise<PartnerView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const current = await requirePartner(this.deps, input.partnerId);
    let next: PartnerRecord = { ...current, updatedAt: now };
    if (input.input) {
      const content = partnerContent(input.input);
      if (content.kind !== current.kind) {
        throw RecoveryErrors.invalid(
          'input.kind',
          'Le métier d’un partenaire ne change pas : créez une autre fiche.',
        );
      }
      next = { ...next, ...content };
    }
    const reason = oneLine(input.statusReason ?? '', 1000) || null;
    if (reason && reason.length > 500)
      throw RecoveryErrors.invalid('statusReason', '500 caractères au plus.');
    const status = (input.status || null) as PartnerStatus | null;
    if (status && status !== 'active' && status !== 'suspended') {
      throw RecoveryErrors.invalid('status', 'Valeur attendue : active, suspended.');
    }
    if (status && status !== current.status) {
      if (!canTransitionPartner(current.status, status)) {
        throw CaseErrors.invalidTransition(
          current.status,
          `Passage du partenaire de « ${current.status} » à « ${status} » refusé.`,
        );
      }
      if (status === 'active' && !next.verificationFileId) {
        throw RecoveryErrors.invalid(
          'input.verificationFileId',
          'Pièce de vérification (nomination, inscription au barreau) requise avant l’activation.',
        );
      }
      if (status === 'suspended' && (!reason || reason.length < 3)) {
        throw RecoveryErrors.invalid('statusReason', 'Motif de la suspension de 3 à 500 caractères.');
      }
      next = {
        ...next,
        status,
        statusReason: status === 'suspended' ? reason : null,
        ...(status === 'active' && current.status === 'pending_verification'
          ? { verifiedBy: staff.userId, verifiedAt: now }
          : {}),
      };
    }
    if (next.verificationFileId !== current.verificationFileId)
      await attachVerification(this.deps, staff, next);
    const outcome = await this.deps.litigation.savePartner(next, current.updatedAt, {
      actorId: staff.userId,
      action:
        status && status !== current.status
          ? `partner.${status === 'active' ? 'activated' : 'suspended'}`
          : 'partner.updated',
      at: now,
      details: { from: current.status, to: next.status },
    });
    if (outcome === 'duplicate') {
      throw RecoveryErrors.invalid('input.userId', 'Ce compte est déjà lié à un autre partenaire.');
    }
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(current.status);
    return viewOf(this.deps, next);
  }
}

export interface PartnerSuggestionView {
  view: PartnerView;
  rank: number;
  coversDebtorArea: boolean;
}

/**
 * Partenaires proposés pour un dossier (SuggestPartners, R-HU-02) : actifs, du métier demandé, ceux
 * qui couvrent la commune du débiteur principal d'abord, les moins chargés et les plus efficaces en
 * tête. Le juriste confirme le premier ou en choisit un autre.
 */
export class SuggestPartnersUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: { caseId: string; kind: string }): Promise<PartnerSuggestionView[]> {
    const staff = requireStaff(LEGAL_ROLES, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const kind = input.kind as PartnerKind;
    if (!KINDS.includes(kind)) throw RecoveryErrors.invalid('kind', 'Valeur attendue : bailiff, lawyer.');
    const partners = await this.deps.litigation.activePartners(kind);
    const stats = await this.deps.litigation.partnerStats(partners.map((p) => p.id));
    const profiles: PartnerProfile[] = partners.map((partner) => {
      const figures = stats.get(partner.id);
      return {
        id: partner.id,
        kind: partner.kind,
        status: partner.status,
        areas: partner.areas,
        openAssignments: figures?.openAssignments ?? 0,
        closedAssignments: figures?.closedAssignments ?? 0,
        successfulAssignments: figures?.successfulAssignments ?? 0,
        averageDays: figures?.averageDays ?? null,
      };
    });
    const debtor = record.debtors.find((candidate) => candidate.role === 'main') ?? record.debtors[0];
    const area = debtor?.communeKey ?? record.communeKey;
    const ranked = rankPartners(profiles, kind, area).slice(0, 20);
    const views = await partnerViews(
      this.deps,
      ranked.map((item) => partners.find((p) => p.id === item.partner.id)!),
    );
    return ranked.map((item, index) => ({
      view: views[index]!,
      rank: index + 1,
      coversDebtorArea: item.coversArea,
    }));
  }
}
