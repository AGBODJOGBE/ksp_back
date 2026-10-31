import { createHmac, timingSafeEqual } from 'node:crypto';

/** Écart toléré entre l'horodatage signé et l'heure de réception (5 minutes, comme les SDK FedaPay). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Signature des notifications FedaPay (documentation publique et SDK officiels, à confirmer avec
 * le compte de test, ADR-031) : en-tête `X-FEDAPAY-SIGNATURE: t=<horodatage>,s=<signature>`, où la
 * signature est le HMAC-SHA256 hexadécimal de `<horodatage>.<corps>` avec le secret du webhook.
 * Comparaison à temps constant ; horodatage hors tolérance refusé (rejeu d'une ancienne notification).
 */
export function signPayload(payload: Uint8Array | string, timestamp: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload))
    .digest('hex');
}

export function signatureHeader(payload: Uint8Array | string, timestamp: number, secret: string): string {
  return `t=${timestamp},s=${signPayload(payload, timestamp, secret)}`;
}

export function verifySignature(
  payload: Uint8Array,
  header: string,
  secret: string,
  now: Date,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (!secret || !header || header.length > 1000) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 's' && value && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(payload, timestamp, secret), 'hex');
  return signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
