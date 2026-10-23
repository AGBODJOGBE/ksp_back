import { formatRecoveryCode, RECOVERY_CODE_COUNT } from '../../domain/mfa/recovery-code';
import { checkTotp, type TotpParameters } from '../../domain/mfa/totp';
import { type ClientKind } from '../../domain/session/session-policy';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type BackofficeSession, type BackofficeSessionOpener } from './backoffice-session-opener';
import { mfaErrors } from './mfa-errors';
import {
  type MfaFactorRepository,
  type RecoveryCodeGenerator,
  type RecoveryCodeHasher,
  type SecretCipher,
  TotpAlreadyEnabledError,
  type TotpGenerator,
} from './mfa.ports';
import { type ClientDetails, type MfaStepGuard } from './mfa-step-guard';

export interface ConfirmTotpInput extends ClientDetails {
  mfaToken: string;
  code: string;
  clientKind: ClientKind;
}

/**
 * UC-ID-09 : le premier code affiché par l'application l'active. Les 10 codes de récupération
 * sont remis une seule fois (seule leur empreinte est conservée), et la session est ouverte.
 */
export class ConfirmTotpUseCase {
  constructor(
    private readonly guard: MfaStepGuard,
    private readonly factors: MfaFactorRepository,
    private readonly totp: TotpGenerator,
    private readonly cipher: SecretCipher,
    private readonly recoveryCodes: RecoveryCodeGenerator,
    private readonly recoveryHasher: RecoveryCodeHasher,
    private readonly sessions: BackofficeSessionOpener,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly parameters: TotpParameters,
  ) {}

  async execute(input: ConfirmTotpInput): Promise<{ session: BackofficeSession; recoveryCodes: string[] }> {
    const now = this.clock.now();
    const step = await this.guard.open(input, now);
    const factor = await this.factors.findTotp(step.account.id);
    if (!factor) throw mfaErrors.enrollmentNotStarted();
    if (factor.enabledAt) throw mfaErrors.alreadyEnrolled();

    const secret = this.cipher.decrypt(factor.secretEncrypted, step.account.id);
    const check = checkTotp({
      code: input.code,
      now,
      parameters: this.parameters,
      lastUsedStep: null,
      codeAt: (timeStep) => this.totp.codeAt(secret, timeStep, this.parameters.digits),
    });
    if (check.kind !== 'valid')
      return this.guard.rejectCode(step, { kind: 'invalid', method: 'totp' }, input);

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.recoveryCodes.generate());
    try {
      const session = await this.sessions.open(
        step,
        {
          kind: 'totp_enrollment',
          factorId: factor.id,
          step: check.step,
          recoveryCodes: codes.map((code) => ({
            id: this.ids.next(),
            hash: this.recoveryHasher.hash(step.account.id, code),
          })),
        },
        input,
        now,
      );
      return { session, recoveryCodes: codes.map(formatRecoveryCode) };
    } catch (error) {
      // Deux confirmations simultanées : la première a activé l'application.
      if (error instanceof TotpAlreadyEnabledError) throw mfaErrors.alreadyEnrolled();
      throw error;
    }
  }
}
