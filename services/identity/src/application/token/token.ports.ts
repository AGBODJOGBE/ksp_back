/** Clé publique de signature au format JWK (RFC 7517). */
export interface PublicSigningKey {
  kid: string;
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg: 'ES256';
  use: 'sig';
}

/**
 * Signataire des jetons (ADR-020). L'implémentation actuelle lit les clés privées dans le coffre à
 * secrets ; une autre pourra déléguer la signature à un service de clés (KMS) sans changer ce port.
 */
export interface TokenSigner {
  /** Signe avec la clé active ; `typ` est l'en-tête de type du jeton (at+jwt pour un jeton d'accès). */
  sign(payload: Record<string, unknown>, typ: string): Promise<string>;
  /** Clés publiées : suivante, active et retirées encore valides. */
  publicKeys(): PublicSigningKey[];
}
