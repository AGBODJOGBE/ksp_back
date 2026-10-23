import { otpauthUri, type TotpParameters } from '../../domain/mfa/totp';
import { type ClientKind } from '../../domain/session/session-policy';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { mfaErrors } from './mfa-errors';
import {
  type MfaFactorRepository,
  type SecretCipher,
  TotpAlreadyEnabledError,
  type TotpGenerator,
} from './mfa.ports';
import { type MfaStepGuard } from './mfa-step-guard';

/** Émetteur affiché par l'application d'authentification. */
export const TOTP_ISSUER = 'KSP';

export interface TotpEnrollment {
  /** Base32 sans remplissage. Transmis une seule fois, jamais journalisé. */
  secret: string;
  otpauthUri: string;
  issuer: string;
  accountName: string;
  digits: number;
  periodSeconds: number;
}

/**
 * UC-ID-09, première connexion d'un compte interne : crée le secret de l'application
 * d'authentification. Il reste inactif jusqu'à ConfirmTotp ; un nouvel appel le remplace.
 */
export class EnrollTotpUseCase {
  constructor(
    private readonly guard: MfaStepGuard,
    private readonly factors: MfaFactorRepository,
    private readonly totp: TotpGenerator,
    private readonly cipher: SecretCipher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly parameters: TotpParameters,
  ) {}

  async execute(input: { mfaToken: string; clientKind: ClientKind }): Promise<TotpEnrollment> {
    const now = this.clock.now();
    const { account } = await this.guard.open(input, now);
    const existing = await this.factors.findTotp(account.id);
    if (existing?.enabledAt) throw mfaErrors.alreadyEnrolled();

    const secret = this.totp.generateSecret();
    try {
      await this.factors.savePendingTotp({
        id: this.ids.next(),
        userId: account.id,
        secretEncrypted: this.cipher.encrypt(secret, account.id),
        now,
      });
    } catch (error) {
      if (error instanceof TotpAlreadyEnabledError) throw mfaErrors.alreadyEnrolled();
      throw error;
    }
    const accountName = account.phoneE164 ?? account.id;
    return {
      secret,
      otpauthUri: otpauthUri({ issuer: TOTP_ISSUER, accountName, secret, parameters: this.parameters }),
      issuer: TOTP_ISSUER,
      accountName,
      digits: this.parameters.digits,
      periodSeconds: this.parameters.periodSeconds,
    };
  }
}
