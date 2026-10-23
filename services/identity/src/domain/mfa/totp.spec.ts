import { acceptedSteps, checkTotp, otpauthUri, timeStep, TOTP_DEFAULTS } from './totp';

/** Code factice : le pas de temps sur 6 chiffres, pour suivre quel pas a été reconnu. */
const codeAt = (step: number) => String(step % 1_000_000).padStart(6, '0');
const at = (seconds: number) => new Date(seconds * 1000);

describe('pas de temps (RFC 6238)', () => {
  it('T = floor(secondes / 30)', () => {
    expect(timeStep(at(59), 30)).toBe(1);
    expect(timeStep(at(1111111109), 30)).toBe(37037036);
    expect(timeStep(at(1111111111), 30)).toBe(37037037);
  });

  it('accepte le pas courant et un pas de chaque côté, du plus récent au plus ancien', () => {
    expect(acceptedSteps(at(1111111111), TOTP_DEFAULTS)).toEqual([37037038, 37037037, 37037036]);
  });
});

describe('checkTotp', () => {
  const now = at(1111111111);
  const check = (code: string, lastUsedStep: number | null = null) =>
    checkTotp({ code, now, parameters: TOTP_DEFAULTS, lastUsedStep, codeAt });

  it('reconnaît le code du pas courant', () => {
    expect(check(codeAt(37037037))).toEqual({ kind: 'valid', step: 37037037 });
  });

  it('tolère un pas de décalage d’horloge, pas deux', () => {
    expect(check(codeAt(37037036))).toEqual({ kind: 'valid', step: 37037036 });
    expect(check(codeAt(37037038))).toEqual({ kind: 'valid', step: 37037038 });
    expect(check(codeAt(37037035))).toEqual({ kind: 'invalid' });
    expect(check(codeAt(37037039))).toEqual({ kind: 'invalid' });
  });

  it('refuse un code rejoué dans sa fenêtre, ou d’un pas antérieur au dernier utilisé', () => {
    expect(check(codeAt(37037037), 37037037)).toEqual({ kind: 'reused' });
    expect(check(codeAt(37037036), 37037037)).toEqual({ kind: 'reused' });
    expect(check(codeAt(37037038), 37037037)).toEqual({ kind: 'valid', step: 37037038 });
  });

  it.each(['', '12345', '1234567', '12a456', ' 37037'])('refuse une saisie mal formée (%p)', (code) => {
    expect(check(code)).toEqual({ kind: 'invalid' });
  });
});

describe('otpauthUri', () => {
  it('produit l’URI lue par les applications d’authentification', () => {
    expect(
      otpauthUri({
        issuer: 'KSP',
        accountName: '+2290197000045',
        secret: 'JBSWY3DPEHPK3PXP',
        parameters: TOTP_DEFAULTS,
      }),
    ).toBe(
      'otpauth://totp/KSP:%2B2290197000045?secret=JBSWY3DPEHPK3PXP&issuer=KSP&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('encode un émetteur avec des espaces', () => {
    expect(
      otpauthUri({ issuer: 'KSP Test', accountName: 'a', secret: 'AA', parameters: TOTP_DEFAULTS }),
    ).toMatch(/^otpauth:\/\/totp\/KSP%20Test:a\?secret=AA&issuer=KSP%20Test&/);
  });
});
