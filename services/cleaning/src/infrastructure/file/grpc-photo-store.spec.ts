import { type fileV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { type FileSubject } from '../../application/ports';
import { GrpcPhotoStore } from './grpc-photo-store';

const SESSION: FileSubject = { type: 'cleaning_session', id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e01' };

const stored = (id: string, createdAt = '2026-12-01T09:00:00.000Z') =>
  ({
    id,
    purpose: 'cleaning_field_photo',
    fileName: `${id}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 2048,
    status: 'available',
    rejectionReason: '',
    ownerId: 'agent',
    subject: SESSION,
    createdAt,
    completedAt: createdAt,
  }) as fileV1.StoredFile;

function store(options: { fail?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    attachFile: (request: fileV1.AttachFileRequest) => {
      calls.push(['attachFile', request]);
      return options.fail
        ? throwError(
            () => new AppError('PERMISSION_DENIED', 'FILE_OWNER_MISMATCH', 'Fichier d’un autre compte.'),
          )
        : of({ file: stored(request.fileId) });
    },
    deleteFile: (request: fileV1.DeleteFileRequest) => {
      calls.push(['deleteFile', request]);
      return of({});
    },
    listFiles: (request: fileV1.ListFilesRequest) => {
      calls.push(['listFiles', request]);
      return of({
        files: [
          {
            file: stored('f-1'),
            download: { url: 'https://files/f-1', expiresAt: '2026-12-01T09:15:00.000Z' },
          },
          { file: stored('f-2', ''), download: undefined },
          { file: undefined, download: undefined },
        ],
      });
    },
  } as unknown as fileV1.FileInternalServiceClient;
  return { calls, photos: new GrpcPhotoStore(client, new GrpcCaller({ target: 'file', retryBackoffMs: 1 })) };
}

describe('GrpcPhotoStore', () => {
  it('rattache, retire et liste les fichiers d’un objet, avec son type (reprise RV-102)', async () => {
    const { photos, calls } = store();
    await photos.attach({ fileId: 'f-1', subject: SESSION, ownerId: 'agent' });
    await photos.remove('f-1', SESSION);
    const listed = await photos.list(SESSION);
    expect(calls).toEqual([
      ['attachFile', { fileId: 'f-1', subject: SESSION, ownerId: 'agent' }],
      ['deleteFile', { fileId: 'f-1', subject: SESSION }],
      ['listFiles', { subject: SESSION, includeDownloadUrls: true }],
    ]);
    expect(listed).toEqual([
      {
        fileId: 'f-1',
        fileName: 'f-1.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2048,
        uploadedAt: new Date('2026-12-01T09:00:00.000Z'),
        downloadUrl: 'https://files/f-1',
        downloadExpiresAt: new Date('2026-12-01T09:15:00.000Z'),
      },
      expect.objectContaining({
        fileId: 'f-2',
        uploadedAt: new Date(0),
        downloadUrl: null,
        downloadExpiresAt: null,
      }),
    ]);
  });

  it('erreur de file transmise telle quelle', async () => {
    const { photos } = store({ fail: true });
    await expect(photos.attach({ fileId: 'f-9', subject: SESSION, ownerId: 'autre' })).rejects.toMatchObject({
      code: 'FILE_OWNER_MISMATCH',
    });
  });
});
