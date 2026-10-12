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
  };

  it('fait l’aller-retour contexte → métadonnées → contexte sans perte', () => {
    expect(contextFromMetadata(metadataFromContext(context))).toEqual(context);
  });

  it('crée un identifiant de corrélation quand l’appelant n’en fournit pas', () => {
    const read = contextFromMetadata(new Metadata());
    expect(read.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(read.user).toBeUndefined();
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
