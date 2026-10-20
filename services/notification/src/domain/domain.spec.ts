import { isDirectSendCaller } from './caller-policy';
import { channelPlan, isPhoneChannel } from './channel';
import { type ChannelAttempt, expiryOf, isExpired, summarizeFailure } from './delivery';
import { parseRecipientUserId, PhoneNumber } from './recipient';
import { findTemplate, invalidVariables } from './template';

describe('channelPlan', () => {
  const phone = ['whatsapp', 'sms'] as const;

  it('commence par WhatsApp quand le canal n’est pas précisé (ADR-021)', () => {
    expect(channelPlan(null, ['sms'], phone)).toEqual(['whatsapp', 'sms']);
  });

  it('respecte le canal demandé puis les bascules, dans l’ordre', () => {
    expect(channelPlan('sms', ['whatsapp'], phone)).toEqual(['sms', 'whatsapp']);
  });

  it('retire les doublons et les canaux que le modèle ne prévoit pas', () => {
    expect(channelPlan('whatsapp', ['email', 'whatsapp', 'sms', 'sms'], phone)).toEqual(['whatsapp', 'sms']);
    expect(channelPlan('email', ['push'], phone)).toEqual([]);
  });

  it('reconnaît les canaux téléphoniques', () => {
    expect(isPhoneChannel('sms')).toBe(true);
    expect(isPhoneChannel('whatsapp')).toBe(true);
    expect(isPhoneChannel('email')).toBe(false);
  });
});

describe('modèles', () => {
  it('identity.otp est un modèle secret, envoyé par WhatsApp ou SMS', () => {
    expect(findTemplate('identity.otp')).toMatchObject({ secret: true, channels: ['whatsapp', 'sms'] });
  });

  it.each(['identity.welcome', '', 'toString', '__proto__'])('le modèle %p est inconnu', (code) => {
    expect(findTemplate(code)).toBeNull();
  });

  it('accepte des variables complètes et bien formées', () => {
    const template = findTemplate('identity.otp')!;
    expect(invalidVariables(template, { code: '482913', expires_in_minutes: '5' })).toEqual([]);
  });

  it('nomme les variables manquantes ou mal formées, sans leur valeur', () => {
    const template = findTemplate('identity.otp')!;
    expect(invalidVariables(template, {})).toEqual(['code', 'expires_in_minutes']);
    expect(invalidVariables(template, { code: '1234567890123456', expires_in_minutes: '0' })).toEqual([
      'code',
      'expires_in_minutes',
    ]);
    expect(invalidVariables(template, { code: '48 29', expires_in_minutes: '5' })).toEqual(['code']);
  });
});

describe('destinataire', () => {
  it('accepte un numéro E.164 et le masque comme identity', () => {
    expect(PhoneNumber.parse('+229 01 97 00 00 45')?.masked()).toBe('+229********45');
    expect(PhoneNumber.parse('+33612345678')?.masked()).toBe('+336******78');
  });

  it.each(['', '0197000045', '+229', '+229abc0000045'])('refuse le numéro %p', (value) => {
    expect(PhoneNumber.parse(value)).toBeNull();
  });

  it('accepte un destinataire sans compte, ou un identifiant UUID', () => {
    expect(parseRecipientUserId('  ')).toEqual({ valid: true, userId: null });
    expect(parseRecipientUserId('0192F1C4-7A2B-7C3D-8E4F-000000000001')).toEqual({
      valid: true,
      userId: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
    });
    expect(parseRecipientUserId('u-1')).toEqual({ valid: false, userId: null });
  });
});

describe('délai de validité', () => {
  const createdAt = new Date('2026-10-20T12:00:00Z');

  it('0 signifie « pas de limite »', () => {
    expect(expiryOf(createdAt, 0)).toBeNull();
    expect(isExpired(null, new Date('2099-01-01T00:00:00Z'))).toBe(false);
  });

  it('le message n’est plus envoyé une fois le délai atteint', () => {
    const expiresAt = expiryOf(createdAt, 300)!;
    expect(expiresAt).toEqual(new Date('2026-10-20T12:05:00Z'));
    expect(isExpired(expiresAt, new Date('2026-10-20T12:04:59.999Z'))).toBe(false);
    expect(isExpired(expiresAt, new Date('2026-10-20T12:05:00Z'))).toBe(true);
  });
});

describe('summarizeFailure', () => {
  it('retient la cause du dernier prestataire appelé, pas celle d’un canal sauté', () => {
    const attempts: ChannelAttempt[] = [
      { channel: 'whatsapp', outcome: 'failed', reason: 'provider_unavailable' },
      { channel: 'sms', outcome: 'skipped' },
    ];
    expect(summarizeFailure(attempts, false)).toEqual({
      channelsTried: ['whatsapp', 'sms'],
      reason: 'provider_unavailable',
      recipientRejected: false,
    });
  });

  it('aucun prestataire configuré : prestataire indisponible', () => {
    expect(summarizeFailure([{ channel: 'sms', outcome: 'skipped' }], false)).toEqual({
      channelsTried: ['sms'],
      reason: 'provider_unavailable',
      recipientRejected: false,
    });
  });

  it('destinataire refusé par chaque prestataire appelé', () => {
    const attempts: ChannelAttempt[] = [
      { channel: 'whatsapp', outcome: 'failed', reason: 'recipient_invalid' },
      { channel: 'sms', outcome: 'skipped' },
    ];
    expect(summarizeFailure(attempts, false)).toMatchObject({
      reason: 'recipient_invalid',
      recipientRejected: true,
    });
  });

  it('un refus du destinataire suivi d’une panne n’est pas un destinataire invalide', () => {
    const attempts: ChannelAttempt[] = [
      { channel: 'whatsapp', outcome: 'failed', reason: 'recipient_invalid' },
      { channel: 'sms', outcome: 'failed', reason: 'provider_unavailable' },
    ];
    expect(summarizeFailure(attempts, false)).toMatchObject({ recipientRejected: false });
  });

  it('délai dépassé avant la bascule : ttl_expired', () => {
    const attempts: ChannelAttempt[] = [
      { channel: 'whatsapp', outcome: 'failed', reason: 'recipient_invalid' },
    ];
    expect(summarizeFailure(attempts, true)).toEqual({
      channelsTried: ['whatsapp'],
      reason: 'ttl_expired',
      recipientRejected: false,
    });
  });
});

describe('appelants autorisés', () => {
  it.each(['identity', 'document'])('%s peut envoyer directement', (service) => {
    expect(isDirectSendCaller(service)).toBe(true);
  });

  it.each(['gateway', 'payment', ''])('%p ne le peut pas', (service) => {
    expect(isDirectSendCaller(service)).toBe(false);
  });
});
