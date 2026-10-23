/**
 * Règles des codes d'application d'authentification (TOTP, RFC 6238). Le calcul du code lui-même
 * (HMAC-SHA1, RFC 4226) est fourni par l'infrastructure : le domaine décide seulement quels pas
 * de temps sont acceptés et refuse un code déjà utilisé.
 */
export interface TotpParameters {
  digits: number;
  periodSeconds: number;
  /** Pas acceptés de part et d'autre du pas courant (décalage d'horloge du téléphone). */
  skewSteps: number;
}

/** Valeurs par défaut des applications (Google Authenticator, Microsoft Authenticator…). */
export const TOTP_DEFAULTS: TotpParameters = { digits: 6, periodSeconds: 30, skewSteps: 1 };

/** Pas de temps T = floor(secondes depuis 1970 / période) (RFC 6238, section 4.2). */
export function timeStep(now: Date, periodSeconds: number): number {
  return Math.floor(now.getTime() / 1000 / periodSeconds);
}

/** Pas acceptés, du plus récent au plus ancien. */
export function acceptedSteps(now: Date, parameters: TotpParameters): number[] {
  const current = timeStep(now, parameters.periodSeconds);
  const steps: number[] = [];
  for (let offset = parameters.skewSteps; offset >= -parameters.skewSteps; offset -= 1) {
    steps.push(current + offset);
  }
  return steps;
}

export function isTotpCodeFormat(code: string, digits: number): boolean {
  return code.length === digits && /^[0-9]+$/.test(code);
}

export type TotpCheck = { kind: 'valid'; step: number } | { kind: 'invalid' } | { kind: 'reused' };

/**
 * Vérifie un code : il doit correspondre à l'un des pas acceptés, et ce pas doit être postérieur
 * au dernier pas utilisé (un même code, même rejoué dans sa fenêtre, ne sert qu'une fois).
 */
export function checkTotp(input: {
  code: string;
  now: Date;
  parameters: TotpParameters;
  lastUsedStep: number | null;
  codeAt: (step: number) => string;
}): TotpCheck {
  if (!isTotpCodeFormat(input.code, input.parameters.digits)) return { kind: 'invalid' };
  let matched: number | null = null;
  for (const step of acceptedSteps(input.now, input.parameters)) {
    // Toutes les comparaisons sont faites, pour un temps de réponse indépendant du pas trouvé.
    if (sameCode(input.codeAt(step), input.code) && matched === null) matched = step;
  }
  if (matched === null) return { kind: 'invalid' };
  if (input.lastUsedStep !== null && matched <= input.lastUsedStep) return { kind: 'reused' };
  return { kind: 'valid', step: matched };
}

/** Comparaison en temps constant de deux codes de même longueur. */
function sameCode(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * URI d'enrôlement lue par les applications d'authentification (format « Key Uri » de
 * Google Authenticator), à afficher en QR code.
 */
export function otpauthUri(input: {
  issuer: string;
  accountName: string;
  secret: string;
  parameters: TotpParameters;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const query = [
    `secret=${input.secret}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    'algorithm=SHA1',
    `digits=${input.parameters.digits}`,
    `period=${input.parameters.periodSeconds}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
