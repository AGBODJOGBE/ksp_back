import { type AssignedRole } from '../../domain/role/role';
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

describe('AccessTokenIssuer — permissions hors du back-office (rôles de terrain, R-RB-07)', () => {
  const assigned = (change: Partial<AssignedRole>): AssignedRole => ({
    code: 'cleaning_agent',
    scopeType: 'domain',
    scopeId: 'cleaning',
    requiresMfa: false,
    backofficeAccess: false,
    zoneKeys: [],
    permissions: ['cleaning.visit.perform', 'cleaning.session.perform'],
    ...change,
  });
  const ADMIN = assigned({
    code: 'cleaning_admin',
    requiresMfa: true,
    backofficeAccess: true,
    permissions: ['cleaning.agent.manage', 'cleaning.planning.manage'],
  });
  const mobile = (change: Partial<AccessTokenSubject> = {}) =>
    subject({ clientId: 'mobile', mfa: false, amr: ['otp'], ...change });

  const setup = (roles: AssignedRole[]) => {
    const signer = new CapturingSigner();
    const read: string[] = [];
    const issuer = new AccessTokenIssuer(
      signer as unknown as TokenSigner,
      { next: () => 'jti-1' },
      { now: () => new Date('2026-11-20T08:00:00Z') },
      900,
      {
        activeRoles: async (userId) => {
          read.push(userId);
          return roles;
        },
      },
    );
    return { signer, issuer, read };
  };

  it('application agent : perms des seuls rôles sans back-office', async () => {
    const { signer, issuer } = setup([assigned({}), ADMIN]);
    await issuer.issue(mobile());
    expect(signer.signed[0]).toMatchObject({
      client_id: 'mobile',
      roles: [{ role: 'customer', scopeType: 'personal' }],
      perms: ['cleaning.session.perform', 'cleaning.visit.perform'],
    });
    expect(signer.signed[0]).not.toHaveProperty('zone_perms');
    expect(JSON.stringify(signer.signed[0])).not.toContain('cleaning.agent.manage');
  });

  it('rôle de terrain limité à des zones : zone_perms', async () => {
    const { signer, issuer } = setup([assigned({ scopeType: 'zone', scopeId: null, zoneKeys: ['cotonou'] })]);
    await issuer.issue(mobile({ clientId: 'web' }));
    expect(signer.signed[0]).toMatchObject({
      perms: [],
      zone_perms: { cotonou: ['cleaning.session.perform', 'cleaning.visit.perform'] },
    });
  });

  it('compte sans rôle de terrain (client, ou personnel de bureau sur le portail) : jeton sans permissions', async () => {
    for (const roles of [[], [ADMIN]]) {
      const { signer, issuer } = setup(roles);
      await issuer.issue(mobile());
      expect(signer.signed[0]).not.toHaveProperty('perms');
      expect(signer.signed[0]).not.toHaveProperty('zone_perms');
    }
  });

  it('session restreinte d’un compte en cours de suppression : aucune permission, rôles non lus', async () => {
    const { signer, issuer, read } = setup([assigned({})]);
    await issuer.issue(mobile({ roles: [{ role: 'account_deletion_pending', scopeType: 'personal' }] }));
    expect(signer.signed[0]).not.toHaveProperty('perms');
    expect(read).toEqual([]);
  });

  it('session du back-office : seules les permissions du back-office reçues, jamais celles de terrain', async () => {
    const { signer, issuer, read } = setup([assigned({}), ADMIN]);
    await issuer.issue(subject({ perms: ['cleaning.agent.manage'], zonePerms: {} }));
    expect(signer.signed[0]).toMatchObject({ client_id: 'backoffice', perms: ['cleaning.agent.manage'] });
    expect(JSON.stringify(signer.signed[0])).not.toContain('cleaning.session.perform');
    expect(read).toEqual([]);
  });
});
