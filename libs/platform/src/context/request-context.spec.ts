import { Metadata } from '@grpc/grpc-js';
import {
  contextFromMetadata,
  currentContext,
  METADATA_KEYS,
  metadataFromContext,
  type RequestContext,
  runWithContext,
} from './request-context';

describe('contexte de requête', () => {
  const context: RequestContext = {
    correlationId: 'corr-1',
    causationId: 'evt-9',
    user: {
      userId: 'u-1',
      sessionId: 's-1',
      activeContext: 'org-7',
      roles: [{ role: 'org_admin', scopeType: 'org', scopeId: 'org-7' }],
      mfa: true,
      authTime: 1760000000,
    },
    client: { ip: '196.192.10.4', userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
  };

  it('fait l’aller-retour contexte → métadonnées → contexte sans perte', () => {
    expect(contextFromMetadata(metadataFromContext(context))).toEqual(context);
  });

  it('transmet les permissions du jeton (perms, zone_perms) aux services (ADR-057, décision 4)', () => {
    const withPermissions: RequestContext = {
      correlationId: 'corr-3',
      user: {
        ...context.user!,
        permissions: ['cleaning.catalog.read', 'cleaning.request.read'],
        zonePermissions: { 'porto-novo': ['cleaning.request.process'] },
      },
    };
    const metadata = metadataFromContext(withPermissions);
    expect(metadata.get(METADATA_KEYS.permissions)).toEqual([
      '["cleaning.catalog.read","cleaning.request.read"]',
    ]);
    expect(contextFromMetadata(metadata)).toEqual(withPermissions);
  });

  it('sans permission dans le jeton, rien n’est transmis ; des permissions illisibles sont ignorées', () => {
    const metadata = metadataFromContext(context);
    expect(metadata.get(METADATA_KEYS.permissions)).toEqual([]);
    expect(metadata.get(METADATA_KEYS.zonePermissions)).toEqual([]);
    metadata.set(METADATA_KEYS.permissions, '{"pas":"une liste"}');
    metadata.set(METADATA_KEYS.zonePermissions, '{"cotonou":"pas une liste","ouidah":[1]}');
    const read = contextFromMetadata(metadata);
    expect(read.user).not.toHaveProperty('permissions');
    expect(read.user).not.toHaveProperty('zonePermissions');
  });

  it('crée un identifiant de corrélation quand l’appelant n’en fournit pas', () => {
    const read = contextFromMetadata(new Metadata());
    expect(read.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(read.user).toBeUndefined();
    expect(read.client).toBeUndefined();
  });

  it('transmet l’adresse IP et l’appareil du client, même sans utilisateur connecté', () => {
    const read = contextFromMetadata(
      metadataFromContext({ correlationId: 'corr-2', client: { ip: '196.192.10.4' } }),
    );
    expect(read.user).toBeUndefined();
    expect(read.client).toEqual({ ip: '196.192.10.4' });
  });

  it('ignore des rôles illisibles au lieu de planter', () => {
    const metadata = new Metadata();
    metadata.set(METADATA_KEYS.userId, 'u-1');
    metadata.set(METADATA_KEYS.roles, '{pas du json');
    expect(contextFromMetadata(metadata).user?.roles).toEqual([]);
  });

  it('isole le contexte de chaque traitement, même en parallèle', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithContext({ correlationId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
          seen.push(`${id}=${currentContext()?.correlationId}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a=a', 'b=b', 'c=c']);
    expect(currentContext()).toBeUndefined();
  });
});
