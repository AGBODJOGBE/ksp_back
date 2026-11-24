import { AppError, runWithContext } from '@ksp/platform';
import { type StoredPhoto } from '../ports';
import {
  agentRecord,
  asStaff,
  asUser,
  fakeCipher,
  InMemoryPlanning,
  NOW,
  planningDeps,
  STAFF,
} from '../testing/planning-fakes';
import { GetAgentIdDocumentUseCase } from './agent-id-document.use-case';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );
const FRONT = '0192f1c4-0000-7000-8000-0000000f0002';
const BACK = '0192f1c4-0000-7000-8000-0000000f0003';
const UPLOADED = new Date('2026-11-10T09:30:00Z');
const EXPIRES = new Date('2026-11-20T07:05:00Z');

const stored = (fileId: string): StoredPhoto => ({
  fileId,
  fileName: 'piece.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 120_000,
  uploadedAt: UPLOADED,
  downloadUrl: `https://files.ksp.test/${fileId}?signature=secret`,
  downloadExpiresAt: EXPIRES,
});

/** Agent dont la pièce d'identité (recto, verso) est chiffrée sur sa fiche. */
function setup(files: StoredPhoto[] = [stored(FRONT), stored(BACK)]) {
  const planning = new InMemoryPlanning();
  const { deps } = planningDeps(planning);
  const listed: unknown[] = [];
  deps.photos = {
    attach: async () => undefined,
    remove: async () => undefined,
    list: async (subject) => {
      listed.push(subject);
      return files;
    },
  };
  planning.addAgent(
    agentRecord('a1', {
      idDocumentEncrypted: fakeCipher.encrypt(
        JSON.stringify({ frontFileId: FRONT, backFileId: BACK }),
        'agent:a1:id_document',
      ),
    }),
  );
  const read = (agentId = 'a1') => new GetAgentIdDocumentUseCase(deps).execute(agentId);
  return { planning, deps, listed, read };
}

describe('GetAgentIdDocument (UC-NT-34, partie 16.3)', () => {
  it('rend le recto et le verso avec leurs adresses temporaires, et trace la consultation', async () => {
    const { planning, listed, read } = setup();
    expect(await asStaff(() => read())).toEqual({
      front: { fileId: FRONT, uploadedAt: UPLOADED, url: stored(FRONT).downloadUrl, urlExpiresAt: EXPIRES },
      back: { fileId: BACK, uploadedAt: UPLOADED, url: stored(BACK).downloadUrl, urlExpiresAt: EXPIRES },
    });
    expect(listed).toEqual([{ type: 'cleaning_agent', id: 'a1' }]);
    // Qui, quel agent, quand : ni fichier, ni adresse, ni contenu de la pièce.
    expect(planning.audit).toEqual([
      { actorId: STAFF, action: 'agent.id_document_read', entityType: 'agent', entityId: 'a1', at: NOW },
    ]);
    expect(planning.events).toEqual([]);
  });

  it('chaque consultation est tracée', async () => {
    const { planning, read } = setup();
    await asStaff(() => read());
    await asStaff(() => read(), '0192f1c4-0000-7000-8000-00000000a009');
    expect(planning.audit.map((entry) => entry.actorId)).toEqual([
      STAFF,
      '0192f1c4-0000-7000-8000-00000000a009',
    ]);
  });

  it('fichier qui n’est plus conservé chez file : sans adresse, daté de la candidature', async () => {
    const { planning, read } = setup([stored(FRONT)]);
    const document = await asStaff(() => read());
    expect(document.back).toEqual({
      fileId: BACK,
      uploadedAt: planning.state.agents.get('a1')!.createdAt,
      url: null,
      urlExpiresAt: null,
    });
    expect(planning.audit).toHaveLength(1);
  });

  it('agent inconnu, ou sans pièce d’identité : introuvable, rien n’est tracé', async () => {
    const { planning, read } = setup();
    expect(await failure(asStaff(() => read('zz')))).toMatchObject({ code: 'CLEANING_AGENT_NOT_FOUND' });
    planning.addAgent(agentRecord('a2'));
    expect(await failure(asStaff(() => read('a2')))).toMatchObject({
      kind: 'NOT_FOUND',
      code: 'CLEANING_AGENT_NOT_FOUND',
      details: { reason: 'id_document_missing' },
    });
    expect(planning.audit).toEqual([]);
  });

  it('file en échec : erreur transmise, aucune consultation tracée', async () => {
    const { planning, deps, read } = setup();
    deps.photos.list = async () => {
      throw new AppError('UNAVAILABLE', 'FILE_STORAGE_UNAVAILABLE', 'Stockage injoignable.');
    };
    expect(await failure(asStaff(() => read()))).toMatchObject({ code: 'FILE_STORAGE_UNAVAILABLE' });
    expect(planning.audit).toEqual([]);
  });

  it('réservé à l’admin Nettoyage : connexion, double authentification et permission', async () => {
    const { planning, read } = setup();
    expect(await failure(read())).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await failure(asUser(() => read()))).toMatchObject({ code: 'AUTH_MFA_REQUIRED' });
    const withPermissions = (permissions: string[]) =>
      runWithContext(
        {
          correlationId: 'test',
          callerService: 'gateway',
          user: {
            userId: STAFF,
            sessionId: 's',
            activeContext: 'personal',
            roles: [],
            mfa: true,
            authTime: Math.floor(Date.now() / 1000),
            permissions,
          },
        },
        () => read(),
      );
    // Le superviseur lit les fiches (cleaning.planning.manage), jamais la pièce d'identité.
    expect(await failure(withPermissions(['cleaning.planning.manage']))).toMatchObject({
      code: 'AUTH_FORBIDDEN',
      details: { permission: 'cleaning.agent.manage' },
    });
    expect(planning.audit).toEqual([]);
    expect((await withPermissions(['cleaning.agent.manage'])).front.fileId).toBe(FRONT);
  });
});
