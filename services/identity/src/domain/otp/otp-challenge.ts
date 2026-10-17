import { type PhoneNumber } from '../user/phone-number';
import { type OtpPolicy } from './otp-policy';

export type OtpChannel = 'sms' | 'whatsapp';
export type OtpPurpose = 'login';

/**
 * Un code envoyé à un numéro (UC-ID-01). Le code lui-même n'est jamais conservé :
 * seulement son empreinte (HMAC), calculée hors du domaine.
 */
export interface OtpChallenge {
  id: string;
  target: PhoneNumber;
  channel: OtpChannel;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  ip: string | null;
  createdAt: Date;
}

export function newOtpChallenge(input: {
  id: string;
  target: PhoneNumber;
  channel: OtpChannel;
  purpose: OtpPurpose;
  codeHash: string;
  ip: string | null;
  now: Date;
  policy: OtpPolicy;
}): OtpChallenge {
  return {
    id: input.id,
    target: input.target,
    channel: input.channel,
    purpose: input.purpose,
    codeHash: input.codeHash,
    attempts: 0,
    expiresAt: new Date(input.now.getTime() + input.policy.ttlSeconds * 1000),
    ip: input.ip,
    createdAt: input.now,
  };
}

/** L'autre canal, essayé si le premier échoue. */
export function fallbackChannel(channel: OtpChannel): OtpChannel {
  return channel === 'sms' ? 'whatsapp' : 'sms';
}
