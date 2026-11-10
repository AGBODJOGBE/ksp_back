import { AppError } from '@ksp/platform';
import { incomingKeyFor, storageKeyFor } from '../domain/stored-file';
import {
  asService,
  asUser,
  JPEG_BYTES,
  MISSION_SUBJECT,
  OTHER_USER_ID,
  OWNER_ID,
  PDF_BYTES,
  PNG_BYTES,
  testDeps,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const HOUR = 3_600_000;

function setup(overrides = {}) {
  const ctx = testDeps(overrides);
  return { ...ctx, useCases: createUseCases(ctx.deps) };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Erreur attendue');
}

const PHOTO = {
  purpose: 'cleaning_intervention_photo',
  fileName: 'avant.png',
  contentType: 'image/png',
  sizeBytes: PNG_BYTES.length,
};

/** Photo déclarée, envoyée au stockage et confirmée par son propriétaire. */
async function availablePhoto(ctx: ReturnType<typeof setup>, owner = OWNER_ID) {
  const ticket = await asUser(owner, () => ctx.useCases.createUpload.execute(PHOTO));
  ctx.storage.put(incomingKeyFor(ticket.file.id), PNG_BYTES, 'image/png');
  return asUser(owner, () => ctx.useCases.completeUpload.byOwner(ticket.file.id));
}

describe('envoi par un compte connecté', () => {
  it('déclare le fichier en attente et renvoie une adresse PUT présignée, signée avec le type', async () => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    expect(ticket.file).toMatchObject({
      purpose: 'cleaning_intervention_photo',
      fileName: 'avant.png',
      status: 'pending',
      ownerId: OWNER_ID,
      subject: null,
    });
    expect(ticket.file.storageKey).toBe(storageKeyFor('cleaning_intervention_photo', ticket.file.id));
    expect(ticket.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } });
    expect(ticket.upload.expiresAt.toISOString()).toBe('2026-11-07T09:15:00.000Z');
  });

  it('le propriétaire est le compte connecté ; sans connexion, refus', async () => {
    const ctx = setup();
    expect((await rejection(ctx.useCases.createUpload.execute(PHOTO))).code).toBe('AUTH_REQUIRED');
  });

  it.each([
    ['finalité inconnue', { purpose: 'selfie' }, 'FILE_VALIDATION_FAILED'],
    ['nom vide', { fileName: ' / ' }, 'FILE_VALIDATION_FAILED'],
    ['taille nulle', { sizeBytes: 0 }, 'FILE_VALIDATION_FAILED'],
    ['type refusé', { contentType: 'application/pdf' }, 'FILE_TYPE_NOT_ALLOWED'],
    ['type HTML', { contentType: 'text/html' }, 'FILE_TYPE_NOT_ALLOWED'],
    ['trop volumineux', { sizeBytes: 8 * 1024 * 1024 + 1 }, 'FILE_TOO_LARGE'],
    [
      'finalité réservée aux services',
      { purpose: 'generated_document', contentType: 'application/pdf' },
      'FILE_PURPOSE_FORBIDDEN',
    ],
  ])('%s : %s', async (_label, change, code) => {
    const ctx = setup();
    const error = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.createUpload.execute({ ...PHOTO, ...change })),
    );
    expect(error.code).toBe(code);
    expect(ctx.files.rows.size).toBe(0);
  });

  it('type MIME normalisé (casse, paramètres)', async () => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () =>
      ctx.useCases.createUpload.execute({ ...PHOTO, contentType: 'Image/PNG; charset=binary' }),
    );
    expect(ticket.file.contentType).toBe('image/png');
  });

  it('quota : envois en attente simultanés, puis volume sur 24 heures', async () => {
    const ctx = setup({ maxPendingPerOwner: 2, dailyBytesPerOwner: 30 });
    await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    const pending = await rejection(asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO)));
    expect(pending.code).toBe('FILE_QUOTA_EXCEEDED');
    expect(pending.details).toEqual({ limit: 'pending_uploads', value: 2 });
    // Un autre compte n'est pas concerné.
    await asUser(OTHER_USER_ID, () => ctx.useCases.createUpload.execute(PHOTO));

    const daily = setup({ dailyBytesPerOwner: 30 });
    await availablePhoto(daily);
    await availablePhoto(daily);
    const volume = await rejection(asUser(OWNER_ID, () => daily.useCases.createUpload.execute(PHOTO)));
    expect(volume.details).toEqual({ limit: 'daily_bytes', value: 30 });
    daily.clock.advance(24 * HOUR + 1);
    await asUser(OWNER_ID, () => daily.useCases.createUpload.execute(PHOTO));
  });
});

/** Clé du stockage que vise l'adresse d'envoi présignée (là où le client dépose le contenu). */
function uploadKey(ticket: { upload: { url: string } }): string {
  return decodeURIComponent(new URL(ticket.upload.url).pathname.replace('/ksp-files/', ''));
}

describe('confirmation de l’envoi', () => {
  it('contenu vérifié puis copié : un nouvel envoi à l’adresse présignée ne le remplace pas (ADR-050)', async () => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    expect(uploadKey(ticket)).not.toBe(ticket.file.storageKey);
    ctx.storage.put(uploadKey(ticket), PNG_BYTES, 'image/png');
    const file = await asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id));
    expect(file.status).toBe('available');
    expect(ctx.storage.objects.get(file.storageKey)?.bytes).toEqual(PNG_BYTES);
    expect(ctx.storage.objects.has(uploadKey(ticket))).toBe(false);

    // L'adresse présignée sert encore jusqu'à son expiration : le contenu vérifié ne change pas.
    ctx.storage.put(uploadKey(ticket), new TextEncoder().encode('<html>piège</html>'), 'image/png');
    expect(ctx.storage.objects.get(file.storageKey)?.bytes).toEqual(PNG_BYTES);
  });

  it('contenu remplacé entre la vérification et la copie : rien n’est publié', async () => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    ctx.storage.put(uploadKey(ticket), PNG_BYTES, 'image/png');
    ctx.storage.replaceBeforeCopy = new TextEncoder().encode('<html>piège</html>');
    const error = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id)),
    );
    expect(error.code).toBe('FILE_NOT_UPLOADED');
    expect(ctx.storage.objects.has(ticket.file.storageKey)).toBe(false);
    expect(ctx.files.rows.get(ticket.file.id)?.status).toBe('pending');
  });

  it('contenu conforme : disponible ; confirmation rejouée sans effet', async () => {
    const ctx = setup();
    const file = await availablePhoto(ctx);
    expect(file).toMatchObject({ status: 'available', completedAt: new Date('2026-11-07T09:00:00.000Z') });
    const again = await asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(file.id));
    expect(again.status).toBe('available');
  });

  it('contenu pas encore reçu : FILE_NOT_UPLOADED, le fichier reste en attente', async () => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    const error = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id)),
    );
    expect(error.code).toBe('FILE_NOT_UPLOADED');
    expect(ctx.files.rows.get(ticket.file.id)?.status).toBe('pending');
  });

  it.each([
    ['taille différente', Uint8Array.from([...PNG_BYTES, 0]), 'image/png', 'size_mismatch'],
    ['JPEG annoncé PNG', Uint8Array.from([...JPEG_BYTES, 0, 0]), 'image/png', 'type_mismatch'],
    ['HTML déguisé', new TextEncoder().encode('<html>hello!'), 'image/png', 'type_mismatch'],
  ])('%s : rejeté, contenu effacé du stockage', async (_label, bytes, storedType, reason) => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    ctx.storage.put(incomingKeyFor(ticket.file.id), bytes, storedType);
    const error = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id)),
    );
    expect(error.code).toBe('FILE_UPLOAD_REJECTED');
    expect(error.details).toEqual({ reason });
    expect(ctx.files.rows.get(ticket.file.id)).toMatchObject({ status: 'rejected', rejectionReason: reason });
    expect(ctx.storage.objects.has(ticket.file.storageKey)).toBe(false);
    // Rejouée : même refus.
    const again = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id)),
    );
    expect(again.details).toEqual({ reason });
  });

  it('antivirus : un contenu infecté est rejeté (point d’extension)', async () => {
    const ctx = setup();
    ctx.scanner.verdict = 'infected';
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    ctx.storage.put(incomingKeyFor(ticket.file.id), PNG_BYTES, 'image/png');
    const error = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id)),
    );
    expect(error.details).toEqual({ reason: 'malware' });
  });

  it('stockage injoignable : FILE_STORAGE_UNAVAILABLE, rien n’est changé', async () => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    ctx.storage.down = true;
    const error = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id)),
    );
    expect(error.code).toBe('FILE_STORAGE_UNAVAILABLE');
    expect(ctx.files.rows.get(ticket.file.id)?.status).toBe('pending');
  });

  it('fichier d’un autre compte : introuvable', async () => {
    const ctx = setup();
    const ticket = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    const error = await rejection(
      asUser(OTHER_USER_ID, () => ctx.useCases.completeUpload.byOwner(ticket.file.id)),
    );
    expect(error.code).toBe('FILE_NOT_FOUND');
  });
});

describe('lecture par le propriétaire', () => {
  it('métadonnées et adresse de lecture courte', async () => {
    const ctx = setup();
    const file = await availablePhoto(ctx);
    expect((await asUser(OWNER_ID, () => ctx.useCases.getMyFile.execute(file.id))).id).toBe(file.id);
    const link = await asUser(OWNER_ID, () => ctx.useCases.createMyDownloadUrl.execute(file.id));
    expect(link.url).toContain(file.storageKey);
    expect(link.expiresAt.toISOString()).toBe('2026-11-07T09:05:00.000Z');
  });

  it('un autre compte ne voit rien (404) ; un fichier en attente n’a pas d’adresse de lecture', async () => {
    const ctx = setup();
    const file = await availablePhoto(ctx);
    expect((await rejection(asUser(OTHER_USER_ID, () => ctx.useCases.getMyFile.execute(file.id)))).code).toBe(
      'FILE_NOT_FOUND',
    );
    const pending = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    const error = await rejection(
      asUser(OWNER_ID, () => ctx.useCases.createMyDownloadUrl.execute(pending.file.id)),
    );
    expect(error.code).toBe('FILE_NOT_AVAILABLE');
  });

  it('identifiant mal formé : FILE_VALIDATION_FAILED', async () => {
    const ctx = setup();
    expect((await rejection(asUser(OWNER_ID, () => ctx.useCases.getMyFile.execute('abc')))).code).toBe(
      'FILE_VALIDATION_FAILED',
    );
  });
});

describe('services métier', () => {
  it('rattachement par le service responsable, au nom du propriétaire ; idempotent', async () => {
    const ctx = setup();
    const file = await availablePhoto(ctx);
    const attach = () =>
      asService('cleaning', () =>
        ctx.useCases.attachFile.execute({ fileId: file.id, subject: MISSION_SUBJECT, ownerId: OWNER_ID }),
      );
    expect(await attach()).toMatchObject({ subject: MISSION_SUBJECT, attachedBy: 'cleaning' });
    expect((await attach()).subject).toEqual(MISSION_SUBJECT);
  });

  it('rattachement refusé : autre service, autre propriétaire, autre objet, fichier en attente', async () => {
    const ctx = setup();
    const file = await availablePhoto(ctx);
    const attach = (service: string, input: Record<string, unknown>) =>
      rejection(
        asService(service, () =>
          ctx.useCases.attachFile.execute({
            fileId: file.id,
            subject: MISSION_SUBJECT,
            ownerId: OWNER_ID,
            ...input,
          }),
        ),
      );
    expect((await attach('gateway', {})).code).toBe('FILE_CALLER_FORBIDDEN');
    expect((await attach('recovery', {})).code).toBe('FILE_NOT_FOUND');
    expect((await attach('cleaning', { ownerId: OTHER_USER_ID })).code).toBe('FILE_OWNER_MISMATCH');
    await asService('cleaning', () =>
      ctx.useCases.attachFile.execute({ fileId: file.id, subject: MISSION_SUBJECT, ownerId: OWNER_ID }),
    );
    const other = { type: 'cleaning_intervention', id: '0192f1c4-0000-7000-8000-00000000b002' };
    expect((await attach('cleaning', { subject: other })).code).toBe('FILE_ALREADY_ATTACHED');

    const pending = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    const error = await rejection(
      asService('cleaning', () =>
        ctx.useCases.attachFile.execute({
          fileId: pending.file.id,
          subject: MISSION_SUBJECT,
          ownerId: OWNER_ID,
        }),
      ),
    );
    expect(error.code).toBe('FILE_NOT_AVAILABLE');
  });

  it('fichiers d’un objet avec adresses de lecture ; adresse pour un utilisateur autorisé par le service', async () => {
    const ctx = setup();
    const file = await availablePhoto(ctx);
    await asService('cleaning', () =>
      ctx.useCases.attachFile.execute({ fileId: file.id, subject: MISSION_SUBJECT, ownerId: OWNER_ID }),
    );
    const listed = await asService('cleaning', () =>
      ctx.useCases.listFiles.execute({ subject: MISSION_SUBJECT, includeDownloadUrls: true }),
    );
    expect(listed.map((item) => item.file.id)).toEqual([file.id]);
    expect(listed[0]!.download?.url).toContain(file.storageKey);
    // Un service ne voit pas les fichiers des finalités d'un autre.
    expect(
      await asService('recovery', () => ctx.useCases.listFiles.execute({ subject: MISSION_SUBJECT })),
    ).toEqual([]);

    const link = await asService('cleaning', () =>
      ctx.useCases.createDownloadUrl.execute({ fileId: file.id, subject: MISSION_SUBJECT }),
    );
    expect(link.download.url).toContain(file.storageKey);
    const wrongSubject = await rejection(
      asService('cleaning', () =>
        ctx.useCases.createDownloadUrl.execute({
          fileId: file.id,
          subject: { type: 'cleaning_intervention', id: 'autre' },
        }),
      ),
    );
    expect(wrongSubject.code).toBe('FILE_NOT_FOUND');
  });

  it('envoi par le service (PDF généré), rattaché dès la déclaration, puis confirmé', async () => {
    const ctx = setup();
    const subject = { type: 'billing_invoice', id: '0192f1c4-0000-7000-8000-00000000f001' };
    const ticket = await asService('document', () =>
      ctx.useCases.createServiceUpload.execute({
        purpose: 'generated_document',
        fileName: 'Facture F-2026-0012.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
        subject,
        ownerId: OWNER_ID,
      }),
    );
    expect(ticket.file).toMatchObject({ subject, attachedBy: 'document', ownerId: OWNER_ID });
    ctx.storage.put(incomingKeyFor(ticket.file.id), PDF_BYTES, 'application/pdf');
    const file = await asService('document', () => ctx.useCases.completeUpload.byService(ticket.file.id));
    expect(file.status).toBe('available');
    // Une autre finalité, ou un autre service : refus.
    const forbidden = await rejection(
      asService('cleaning', () =>
        ctx.useCases.createServiceUpload.execute({
          ...PHOTO,
          purpose: 'generated_document',
          contentType: 'application/pdf',
          subject,
        }),
      ),
    );
    expect(forbidden.code).toBe('FILE_PURPOSE_FORBIDDEN');
  });

  it('suppression logique par le service, effacement physique après le délai de grâce ; idempotente', async () => {
    const ctx = setup();
    const file = await availablePhoto(ctx);
    await asService('cleaning', () =>
      ctx.useCases.attachFile.execute({ fileId: file.id, subject: MISSION_SUBJECT, ownerId: OWNER_ID }),
    );
    const remove = () =>
      asService('cleaning', () =>
        ctx.useCases.deleteFile.execute({ fileId: file.id, subject: MISSION_SUBJECT }),
      );
    await remove();
    await remove();
    expect(ctx.files.rows.get(file.id)).toMatchObject({
      status: 'deleted',
      deletionReason: 'deleted_by_service',
    });
    expect((await rejection(asUser(OWNER_ID, () => ctx.useCases.getMyFile.execute(file.id)))).code).toBe(
      'FILE_NOT_FOUND',
    );
    expect((await ctx.useCases.purgeFiles.execute()).erased).toBe(0);
    ctx.clock.advance(168 * HOUR);
    expect((await ctx.useCases.purgeFiles.execute()).erased).toBe(1);
    expect(ctx.files.rows.has(file.id)).toBe(false);
    expect(ctx.storage.objects.has(file.storageKey)).toBe(false);
  });
});

describe('purge', () => {
  it('envois non confirmés et fichiers jamais rattachés supprimés puis effacés', async () => {
    const ctx = setup();
    const pending = await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    ctx.storage.put(incomingKeyFor(pending.file.id), PNG_BYTES, 'image/png');
    const orphan = await availablePhoto(ctx);
    ctx.clock.advance(23 * HOUR);
    expect(await ctx.useCases.purgeFiles.execute()).toEqual({
      expiredPending: 0,
      expiredUnattached: 0,
      erased: 0,
      errors: 0,
    });
    ctx.clock.advance(2 * HOUR);
    expect(await ctx.useCases.purgeFiles.execute()).toEqual({
      expiredPending: 1,
      expiredUnattached: 1,
      erased: 2,
      errors: 0,
    });
    expect(ctx.files.rows.size).toBe(0);
    expect(ctx.storage.objects.has(pending.file.storageKey)).toBe(false);
    expect(ctx.storage.removed).toContain(orphan.storageKey);
  });

  it('stockage injoignable : la ligne reste, effacement repris au passage suivant', async () => {
    const ctx = setup();
    await asUser(OWNER_ID, () => ctx.useCases.createUpload.execute(PHOTO));
    ctx.clock.advance(25 * HOUR);
    ctx.storage.down = true;
    expect((await ctx.useCases.purgeFiles.execute()).errors).toBe(1);
    expect(ctx.files.rows.size).toBe(1);
    ctx.storage.down = false;
    expect((await ctx.useCases.purgeFiles.execute()).erased).toBe(1);
  });
});

describe('compte supprimé (identity.user.deleted)', () => {
  it('photo de profil et fichiers non rattachés effacés ; pièces gardées, détachées du compte ; idempotent', async () => {
    const ctx = setup();
    const kept = await availablePhoto(ctx);
    await asService('cleaning', () =>
      ctx.useCases.attachFile.execute({ fileId: kept.id, subject: MISSION_SUBJECT, ownerId: OWNER_ID }),
    );
    const orphan = await availablePhoto(ctx);
    const avatarTicket = await asUser(OWNER_ID, () =>
      ctx.useCases.createUpload.execute({ ...PHOTO, purpose: 'avatar', fileName: 'Koffi Adjovi.png' }),
    );
    ctx.storage.put(incomingKeyFor(avatarTicket.file.id), PNG_BYTES, 'image/png');
    await asUser(OWNER_ID, () => ctx.useCases.completeUpload.byOwner(avatarTicket.file.id));
    await asService('identity', () =>
      ctx.useCases.attachFile.execute({
        fileId: avatarTicket.file.id,
        subject: { type: 'identity_user', id: OWNER_ID },
        ownerId: OWNER_ID,
      }),
    );
    const other = await availablePhoto(ctx, OTHER_USER_ID);

    const event = {
      eventId: '0192f1c4-0000-7000-8000-0000000e0001',
      eventType: 'identity.user.deleted',
      userId: OWNER_ID.toUpperCase(),
    };
    expect(await ctx.useCases.eraseAccountFiles.execute(event)).toEqual({
      status: 'processed',
      erased: 2,
      detached: 1,
    });
    expect(await ctx.useCases.eraseAccountFiles.execute(event)).toEqual({
      status: 'duplicate',
      erased: 0,
      detached: 0,
    });

    expect(ctx.files.rows.get(kept.id)).toMatchObject({
      status: 'available',
      ownerId: null,
      fileName: `${kept.id}.png`,
    });
    expect(ctx.files.rows.get(orphan.id)).toMatchObject({
      status: 'deleted',
      deletionReason: 'account_deleted',
    });
    expect(ctx.files.rows.get(avatarTicket.file.id)?.status).toBe('deleted');
    expect(ctx.files.rows.get(other.id)?.ownerId).toBe(OTHER_USER_ID);
    expect((await ctx.useCases.purgeFiles.execute()).erased).toBe(2);
  });
});
