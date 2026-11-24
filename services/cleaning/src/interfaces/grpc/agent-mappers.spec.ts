import { toIdDocument } from './agent-mappers';

describe('pièce d’identité → contrat (IdDocument)', () => {
  it('recto et verso : fichier, date du dépôt, adresse temporaire et son échéance', () => {
    expect(
      toIdDocument({
        front: {
          fileId: '0192f1c4-0000-7000-8000-0000000f0002',
          uploadedAt: new Date('2026-11-10T09:30:00Z'),
          url: 'https://files.ksp.test/recto',
          urlExpiresAt: new Date('2026-11-20T07:05:00Z'),
        },
        back: {
          fileId: '0192f1c4-0000-7000-8000-0000000f0003',
          uploadedAt: new Date('2026-11-01T08:00:00Z'),
          url: null,
          urlExpiresAt: null,
        },
      }),
    ).toEqual({
      front: {
        fileId: '0192f1c4-0000-7000-8000-0000000f0002',
        // Valeur de l'énumération du contrat retenue pour une pièce d'identité.
        kind: 'request',
        takenAt: '2026-11-10T09:30:00.000Z',
        url: 'https://files.ksp.test/recto',
        urlExpiresAt: '2026-11-20T07:05:00.000Z',
      },
      // Fichier qui n'est plus conservé : ni adresse ni échéance (null en REST).
      back: {
        fileId: '0192f1c4-0000-7000-8000-0000000f0003',
        kind: 'request',
        takenAt: '2026-11-01T08:00:00.000Z',
      },
    });
  });
});
