import { AccessTokenIssuer, type AccessTokenSubject } from './access-token-issuer';
import { type TokenSigner } from './token.ports';

/** Signataire factice : garde les revendications signées. */
class CapturingSigner implements Pick<TokenSigner, 'sign'> {
  readonly signed: Record<string, unknown>[] = [];
  async sign(claims: Record<string, unknown>): Promise<string> {
    this.signed.push(claims);
    return 'jeton';
  }
}

const subject = (change: Partial<AccessTokenSubject> = {}): AccessTokenSubject => ({
  userId: 'u-1',
  sessionId: 's-1',
  clientId: 'backoffice',
  activeContext: 'personal',
  roles: [{ role: 'customer', scopeType: 'personal' }],
  mfa: true,
  authTime: new Date('2026-11-20T08:00:00Z'),
  amr: ['otp', 'mfa'],
  ...change,
});

describe('AccessTokenIssuer — permissions dans le jeton (ADR-057, décision 4)', () => {
  const setup = () => {
    const signer = new CapturingSigner();
    const issuer = new AccessTokenIssuer(
      signer as unknown as TokenSigner,
      { next: () => 'jti-1' },
      { now: () => new Date('2026-11-20T08:00:00Z') },
      900,
    );
    return { signer, issuer };
  };

  it('écrit perms et zone_perms d’une session du back-office', async () => {
    const { signer, issuer } = setup();
    await issuer.issue(
      subject({ perms: ['cleaning.catalog.read'], zonePerms: { cotonou: ['cleaning.request.process'] } }),
    );
    expect(signer.signed[0]).toMatchObject({
      perms: ['cleaning.catalog.read'],
      zone_perms: { cotonou: ['cleaning.request.process'] },
    });
  });

  it('omet zone_perms vide, et les deux revendications hors du back-office', async () => {
    const { signer, issuer } = setup();
    await issuer.issue(subject({ perms: [], zonePerms: {} }));
    await issuer.issue(subject({ clientId: 'web' }));
    expect(signer.signed[0]).toMatchObject({ perms: [] });
    expect(signer.signed[0]).not.toHaveProperty('zone_perms');
    expect(signer.signed[1]).not.toHaveProperty('perms');
    expect(signer.signed[1]).not.toHaveProperty('zone_perms');
  });
});
