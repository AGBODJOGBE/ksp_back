import { availableMethods, type MfaPolicy, type SecondFactorMethod } from '../../domain/mfa/mfa-challenge';
import { backofficeRoles } from '../../domain/role/role';
import { type ClientKind } from '../../domain/session/session-policy';
import { type RoleRepository } from '../role/role.ports';
import { type IdGenerator } from '../shared/system.ports';
import { type MfaChallengeRepository, type MfaFactorRepository, type MfaTokenGenerator } from './mfa.ports';

/** Réponse de la première étape pour un compte interne : la double authentification à passer. */
export interface MfaRequired {
  /** Transmis une seule fois, jamais journalisé : seule son empreinte est conservée. */
  mfaToken: string;
  expiresAt: Date;
  methods: SecondFactorMethod[];
  /** Première connexion : l'application d'authentification doit être configurée. */
  enrollmentRequired: boolean;
}

/**
 * UC-ID-09, première étape d'une connexion au back-office : après un code par téléphone valide,
 * un compte qui a un rôle du back-office reçoit un jeton court à usage unique au lieu d'une session.
 */
export class OpenMfaChallenge {
  constructor(
    private readonly roles: RoleRepository,
    private readonly factors: MfaFactorRepository,
    private readonly challenges: MfaChallengeRepository,
    private readonly tokens: MfaTokenGenerator,
    private readonly ids: IdGenerator,
    private readonly policy: MfaPolicy,
  ) {}

  async hasBackofficeAccess(userId: string): Promise<boolean> {
    return backofficeRoles(await this.roles.activeRoles(userId)).length > 0;
  }

  /** Consomme la demande de code par téléphone et ouvre l'étape (ChallengeAlreadyConsumedError si rejouée). */
  async open(input: {
    otpChallengeId: string;
    userId: string;
    clientKind: ClientKind;
    deviceLabel: string | null;
    ip: string | null;
    now: Date;
  }): Promise<MfaRequired> {
    const factor = await this.factors.findTotp(input.userId);
    const enrolled = factor?.enabledAt != null;
    const unusedCodes = enrolled ? await this.factors.countUnusedRecoveryCodes(input.userId) : 0;
    const token = this.tokens.generate();
    const expiresAt = new Date(input.now.getTime() + this.policy.tokenTtlSeconds * 1000);
    await this.challenges.openAfterOtp(
      input.otpChallengeId,
      {
        id: this.ids.next(),
        userId: input.userId,
        tokenHash: token.hash,
        clientKind: input.clientKind,
        deviceLabel: input.deviceLabel,
        ip: input.ip,
        createdAt: input.now,
        expiresAt,
      },
      input.now,
    );
    return {
      mfaToken: token.token,
      expiresAt,
      methods: availableMethods(enrolled, unusedCodes),
      enrollmentRequired: !enrolled,
    };
  }
}
