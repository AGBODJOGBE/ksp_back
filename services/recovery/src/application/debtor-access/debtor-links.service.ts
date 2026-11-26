import {
  closedAccessEnd,
  DEFAULT_CLOSED_ACCESS_DAYS,
  type DebtorLink,
  isOpenToDebtor,
  issueLink,
} from '../../domain/debtor-access';
import { loadSettings } from '../settings.use-cases';
import { DebtorAccessErrors } from './debtor-access.errors';
import { type DebtorAccessDeps } from './debtor-access.use-cases';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lien rendu une seule fois à l'émetteur : à mettre dans le message au débiteur, jamais à garder. */
export interface IssuedDebtorLink {
  accessId: string;
  /** Jeton en clair (43 caractères) : seule son empreinte SHA-256 est en base. */
  token: string;
  /** Adresse du portail : `<RECOVERY_DEBTOR_BASE_URL>/<jeton>`. */
  url: string;
  expiresAt: Date;
  /** Un lien précédent du débiteur a été révoqué (renouvellement). */
  renewed: boolean;
}

/**
 * Liens personnels des débiteurs (ADR-061), au service des cas d'usage qui écrivent au débiteur
 * (premier message, relances, message du chargé) ou qui ferment son accès (dossier clos ou refusé,
 * débiteur retiré). Pas de route : aucun contrôle d'appelant ici, chaque appelant fait les siens.
 * À construire avec les dépendances des cas d'usage : `new DebtorLinks(deps)`.
 */
export class DebtorLinks {
  constructor(private readonly deps: Pick<DebtorAccessDeps, 'debtorAccess' | 'settings' | 'clock' | 'ids'>) {}

  /**
   * Lien du débiteur dans ce dossier, valable `debtorLinkDays` jours (30, réglable de 7 à 90) : jeton
   * de 32 octets aléatoires dont seule l'empreinte est gardée. Émettre, c'est aussi renouveler : à
   * chaque relance, un nouveau jeton, et le lien encore actif est révoqué avec ses sessions dans la
   * même transaction (un seul lien actif par débiteur et par dossier). Dossier actif ou suspendu
   * seulement.
   */
  async issue(input: { caseId: string; debtorId: string }): Promise<IssuedDebtorLink> {
    const { reader } = this.deps.debtorAccess;
    if (!UUID.test(input.caseId) || !UUID.test(input.debtorId)) throw DebtorAccessErrors.caseNotFound();
    const caseDebtor = await reader.caseDebtor(input.caseId, input.debtorId);
    if (!caseDebtor) throw DebtorAccessErrors.caseNotFound();
    if (!isOpenToDebtor(caseDebtor.caseStatus)) throw DebtorAccessErrors.caseNotOpen(caseDebtor.caseStatus);

    const now = this.deps.clock.now();
    const { settings } = await loadSettings(this.deps.settings);
    const link = issueLink(now, settings.debtorLinkDays);
    return this.store(input, link, `valable ${settings.debtorLinkDays} jours`);
  }

  /** Jours de lecture seule après la clôture (réglage du service, 30 par défaut). */
  private get closedAccessDays(): number {
    return this.deps.debtorAccess.closedAccessDays ?? DEFAULT_CLOSED_ACCESS_DAYS;
  }

  /**
   * Accès du débiteur à la clôture du dossier : ses liens encore valables le restent, en lecture seule
   * (attestation de solde et reçus), jusqu'à la clôture + N jours (réglable, 30) ; sans cette durée, ou
   * une fois écoulée, ils sont révoqués avec leurs sessions. Rend la fin de l'accès, ou null.
   */
  async closeAccess(input: { caseId: string; closedAt: Date }): Promise<{ until: Date | null }> {
    const now = this.deps.clock.now();
    const until = closedAccessEnd(input.closedAt, this.closedAccessDays);
    if (until === null || now >= until) {
      await this.revoke({ caseId: input.caseId });
      return { until: null };
    }
    await this.deps.debtorAccess.store.restrict({ caseId: input.caseId }, until, now);
    return { until };
  }

  /**
   * Lien en lecture seule d'un débiteur d'un dossier clos, valable jusqu'à la fin de l'accès après la
   * clôture : remis avec l'attestation de solde. Null si cet accès est fermé (0 jour, délai écoulé).
   */
  async issueReadOnly(input: {
    caseId: string;
    debtorId: string;
    closedAt: Date;
  }): Promise<IssuedDebtorLink | null> {
    const now = this.deps.clock.now();
    const until = closedAccessEnd(input.closedAt, this.closedAccessDays);
    if (until === null || now >= until) return null;
    if (!UUID.test(input.caseId) || !UUID.test(input.debtorId)) throw DebtorAccessErrors.caseNotFound();
    const caseDebtor = await this.deps.debtorAccess.reader.caseDebtor(input.caseId, input.debtorId);
    if (!caseDebtor) throw DebtorAccessErrors.caseNotFound();
    if (caseDebtor.caseStatus !== 'closed') throw DebtorAccessErrors.caseNotOpen(caseDebtor.caseStatus);
    const link: DebtorLink = { issuedAt: now, expiresAt: until, revokedAt: null };
    return this.store(input, link, 'en lecture seule après la clôture');
  }

  /** Enregistre un lien neuf (le précédent du débiteur est révoqué) et l'écrit au journal de preuve. */
  private async store(
    input: { caseId: string; debtorId: string },
    link: DebtorLink,
    validity: string,
  ): Promise<IssuedDebtorLink> {
    const { store, journal, secrets, baseUrl } = this.deps.debtorAccess;
    const now = link.issuedAt;
    const token = secrets.newToken();
    const accessId = this.deps.ids.next();
    const issued = await store.issue({
      id: accessId,
      caseId: input.caseId,
      debtorId: input.debtorId,
      tokenHash: secrets.hashToken(token),
      link,
    });
    if (!issued) throw DebtorAccessErrors.caseNotFound();

    const renewed = issued.replaced > 0;
    await journal.record({
      caseId: input.caseId,
      accessId,
      occurredAt: now,
      actorType: 'system',
      actorId: null,
      action: 'debtor_link_issued',
      channel: null,
      summary: renewed
        ? `Lien personnel du débiteur renouvelé, ${validity} ; le précédent est révoqué.`
        : `Lien personnel du débiteur émis, ${validity}.`,
    });
    const url = `${baseUrl.replace(/\/+$/, '')}/${token}`;
    return { accessId, token, url, expiresAt: link.expiresAt, renewed };
  }

  /**
   * Révoque les liens actifs d'un dossier (clos, refusé) ou d'un seul de ses débiteurs, et leurs
   * sessions : un jeton révoqué répond comme un jeton inconnu. Sans effet sur un lien déjà révoqué.
   */
  async revoke(input: { caseId: string; debtorId?: string }): Promise<{ revoked: number }> {
    return { revoked: await this.deps.debtorAccess.store.revoke(input, this.deps.clock.now()) };
  }
}
