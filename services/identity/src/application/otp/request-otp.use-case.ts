import { AppError } from '@ksp/platform';
import { newOtpChallenge, type OtpChannel, type OtpPurpose } from '../../domain/otp/otp-challenge';
import { decideSend, type OtpPolicy } from '../../domain/otp/otp-policy';
import { PhoneNumber } from '../../domain/user/phone-number';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import {
  type OtpChallengeRepository,
  type OtpCodeGenerator,
  type OtpHasher,
  type OtpSender,
} from './otp.ports';

export interface RequestOtpInput {
  phone: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  ip: string | null;
}

export interface RequestOtpOutput {
  challengeId: string;
  maskedTarget: string;
  channel: OtpChannel;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * UC-ID-01, première étape : envoyer un code de connexion.
 * La réponse ne dépend pas de l'existence d'un compte pour ce numéro (anti-énumération) :
 * le compte n'est consulté qu'à la validation du code.
 */
export class RequestOtpUseCase {
  constructor(
    private readonly challenges: OtpChallengeRepository,
    private readonly sender: OtpSender,
    private readonly hasher: OtpHasher,
    private readonly codes: OtpCodeGenerator,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: OtpPolicy,
  ) {}

  async execute(input: RequestOtpInput): Promise<RequestOtpOutput> {
    const target = PhoneNumber.parse(input.phone);
    if (!target) {
      throw AppError.invalid('IDENTITY_PHONE_INVALID', 'Le numéro de téléphone est invalide.');
    }

    const now = this.clock.now();
    const recent = await this.challenges.sentAtSince(target, new Date(now.getTime() - DAY_MS));
    const decision = decideSend(recent, now, this.policy);
    if (!decision.allowed) {
      throw AppError.rateLimited(
        'IDENTITY_OTP_RATE_LIMITED',
        'Trop de codes demandés pour ce numéro. Réessayez plus tard.',
        { retryAfterSeconds: decision.retryAfterSeconds },
      );
    }

    const id = this.ids.next();
    const code = this.codes.generate(this.policy.codeLength);
    const challenge = newOtpChallenge({
      id,
      target,
      channel: input.channel,
      purpose: input.purpose,
      codeHash: this.hasher.hash(id, code),
      ip: input.ip,
      now,
      policy: this.policy,
    });
    await this.challenges.create(challenge);

    let channelUsed: OtpChannel;
    try {
      ({ channelUsed } = await this.sender.send({
        challengeId: id,
        target,
        channel: input.channel,
        code,
        ttlSeconds: this.policy.ttlSeconds,
      }));
    } catch (error) {
      await this.challenges.markSendFailed(id, this.clock.now());
      throw error;
    }

    const sentAt = this.clock.now();
    await this.challenges.markSent(id, channelUsed, sentAt, {
      userId: null,
      purpose: input.purpose,
      channel: channelUsed,
      targetMasked: target.masked(),
    });

    const next = decideSend([...recent, sentAt], sentAt, this.policy);
    return {
      challengeId: id,
      maskedTarget: target.masked(),
      channel: channelUsed,
      expiresInSeconds: this.policy.ttlSeconds,
      resendAfterSeconds: next.allowed ? 0 : next.retryAfterSeconds,
    };
  }
}
