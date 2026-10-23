import { type SecondFactorMethod } from '../../domain/mfa/mfa-challenge';
import { normalizeRecoveryCode } from '../../domain/mfa/recovery-code';
import { checkTotp, type TotpParameters } from '../../domain/mfa/totp';
import { type ClientKind } from '../../domain/session/session-policy';
import { type Clock } from '../shared/system.ports';
import { type BackofficeSession, type BackofficeSessionOpener } from './backoffice-session-opener';
import { mfaErrors } from './mfa-errors';
import {
  type MfaFactorRepository,
  RecoveryCodeAlreadyUsedError,
  type RecoveryCodeHasher,
  type SecondFactorProof,
  type SecretCipher,
  type TotpFactor,
  type TotpGenerator,
  TotpStepAlreadyUsedError,
} from './mfa.ports';
import { type ClientDetails, type MfaStep, type MfaStepGuard } from './mfa-step-guard';

export interface VerifyMfaInput extends ClientDetails {
  mfaToken: string;
  method: SecondFactorMethod;
  code: string;
  clientKind: ClientKind;
}

/**
 * UC-ID-09, seconde étape de connexion d'un compte interne : code de l'application (±1 pas, jamais
 * deux fois le même) ou code de récupération (consommé), puis ouverture de la session back-office.
 * Jamais de code par SMS pour un compte interne (ADR-023).
 */
export class VerifyMfaUseCase {
  constructor(
    private readonly guard: MfaStepGuard,
    private readonly factors: MfaFactorRepository,
    private readonly totp: TotpGenerator,
    private readonly cipher: SecretCipher,
    private readonly recoveryHasher: RecoveryCodeHasher,
    private readonly sessions: BackofficeSessionOpener,
    private readonly clock: Clock,
    private readonly parameters: TotpParameters,
  ) {}

  async execute(input: VerifyMfaInput): Promise<BackofficeSession> {
    const now = this.clock.now();
    const step = await this.guard.open(input, now);
    const factor = await this.factors.findTotp(step.account.id);
    if (!factor?.enabledAt) throw mfaErrors.enrollmentRequired();

    const proof =
      input.method === 'totp'
        ? await this.totpProof(step, factor, input, now)
        : await this.recoveryProof(step, input);
    try {
      return await this.sessions.open(step, proof, input, now);
    } catch (error) {
      // Course entre deux connexions : le même code a été accepté juste avant.
      if (error instanceof TotpStepAlreadyUsedError) {
        return this.guard.rejectCode(step, { kind: 'reused', method: 'totp' }, input);
      }
      if (error instanceof RecoveryCodeAlreadyUsedError) {
        return this.guard.rejectCode(step, { kind: 'invalid', method: 'recovery_code' }, input);
      }
      throw error;
    }
  }

  private async totpProof(
    step: MfaStep,
    factor: TotpFactor,
    input: VerifyMfaInput,
    now: Date,
  ): Promise<SecondFactorProof> {
    const secret = this.cipher.decrypt(factor.secretEncrypted, step.account.id);
    const check = checkTotp({
      code: input.code,
      now,
      parameters: this.parameters,
      lastUsedStep: factor.lastUsedStep,
      codeAt: (timeStep) => this.totp.codeAt(secret, timeStep, this.parameters.digits),
    });
    if (check.kind !== 'valid')
      return this.guard.rejectCode(step, { kind: check.kind, method: 'totp' }, input);
    return { kind: 'totp', factorId: factor.id, step: check.step };
  }

  private async recoveryProof(step: MfaStep, input: VerifyMfaInput): Promise<SecondFactorProof> {
    const normalized = normalizeRecoveryCode(input.code);
    const codeId = normalized
      ? await this.factors.findUnusedRecoveryCode(
          step.account.id,
          this.recoveryHasher.hash(step.account.id, normalized),
        )
      : null;
    if (!codeId) return this.guard.rejectCode(step, { kind: 'invalid', method: 'recovery_code' }, input);
    return { kind: 'recovery_code', codeId };
  }
}
