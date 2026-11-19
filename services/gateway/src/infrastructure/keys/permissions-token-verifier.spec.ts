import { AppError, type VerifiedAccessToken } from '@ksp/platform';
import { SignJWT } from 'jose';
import { PermissionsTokenVerifier } from './permissions-token-verifier';

const verified: VerifiedAccessToken = {
  user: { userId: 'u-1', sessionId: 's-1', activeContext: 'personal', roles: [], mfa: true },
  clientId: 'backoffice',
  tokenId: 'j-1',
  expiresAt: 1_792_400_900,
};

/** Jeton porteur des revendications voulues ; la signature est contrôlée par le vérificateur du kit. */
const token = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('secret-de-test'));

describe('PermissionsTokenVerifier', () => {
  it('ajoute les permissions du jeton (perms, zone_perms) à l’appelant vérifié par le kit', async () => {
    const verifier = new PermissionsTokenVerifier({ verify: async () => verified });
    const caller = await verifier.verify(
      await token({
        perms: ['cleaning.request.read'],
        zone_perms: { cotonou: ['cleaning.claim.manage'], porto: 'mal-formé' },
      }),
    );
    expect(caller).toEqual({
      ...verified,
      permissions: {
        global: ['cleaning.request.read'],
        byZone: { cotonou: ['cleaning.claim.manage'], porto: [] },
      },
    });
  });

  it('jeton émis avant les permissions : aucune permission', async () => {
    const verifier = new PermissionsTokenVerifier({ verify: async () => verified });
    expect((await verifier.verify(await token({}))).permissions).toEqual({ global: [], byZone: {} });
  });

  it('jeton refusé par le kit : l’erreur est rendue telle quelle, le jeton n’est pas lu', async () => {
    const invalid = AppError.unauthenticated('GATEWAY_TOKEN_INVALID', 'Jeton invalide.');
    const verifier = new PermissionsTokenVerifier({ verify: () => Promise.reject(invalid) });
    await expect(verifier.verify('pas-un-jeton')).rejects.toBe(invalid);
  });
});
