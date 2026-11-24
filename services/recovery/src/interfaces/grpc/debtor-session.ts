import { type Metadata } from '@grpc/grpc-js';

/**
 * Métadonnée gRPC où la gateway transmet l'en-tête X-Debtor-Session (ADR-061). Secret : jamais
 * journalisée, jamais renvoyée.
 */
export const DEBTOR_SESSION_METADATA = 'x-debtor-session';

/** Jeton de session du débiteur reçu de la gateway, ou null s'il manque. */
export function debtorSessionToken(metadata: Metadata | undefined): string | null {
  const value = metadata?.get(DEBTOR_SESSION_METADATA)[0];
  if (value === undefined) return null;
  return typeof value === 'string' ? value : value.toString('utf8');
}
