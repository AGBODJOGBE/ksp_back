import { runWithContext } from '@ksp/platform';
import { type Purpose } from '../../domain/purposes';
import { neutralFileName, sameSubject, type FileSubject, type StoredFile } from '../../domain/stored-file';
import {
  type AccountErasure,
  type Clock,
  type Completion,
  type FileDeps,
  type FileRepository,
  type FileSettings,
  type IdGenerator,
  type MalwareScanner,
  type ObjectStat,
  type ObjectStorage,
  type PresignedUpload,
} from '../ports';
import { FileErrors } from '../shared/errors';

/** Doublures en mémoire des ports, pour les tests des cas d'usage. */
export const OWNER_ID = '0192f1c4-0000-7000-8000-00000000c001';
export const OTHER_USER_ID = '0192f1c4-0000-7000-8000-00000000c002';
export const MISSION_SUBJECT: FileSubject = {
  type: 'cleaning_intervention',
  id: '0192f1c4-0000-7000-8000-00000000b001',
};

export const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n');
export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-11-07T09:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequenceIds implements IdGenerator {
  private n = 0;

  next(): string {
    this.n += 1;
    return `0192f1c4-0000-7000-8000-${String(this.n).padStart(12, '0')}`;
  }
}

export class InMemoryFileRepository implements FileRepository {
  readonly rows = new Map<string, StoredFile>();
  readonly processedEvents = new Set<string>();

  async create(file: StoredFile): Promise<void> {
    this.rows.set(file.id, { ...file });
  }

  async findById(id: string): Promise<StoredFile | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async complete(id: string, completion: Completion): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending') return false;
    row.status = completion.status;
    row.completedAt = completion.completedAt;
    if (completion.status === 'rejected') {
      row.rejectionReason = completion.reason;
      row.eraseAfter = completion.eraseAfter;
    }
    return true;
  }

  async attach(
    id: string,
    input: { subject: FileSubject; attachedBy: string; attachedAt: Date },
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'available' || row.subject) return false;
    Object.assign(row, input);
    return true;
  }

  async softDelete(
    id: string,
    input: { reason: StoredFile['deletionReason']; deletedAt: Date; eraseAfter: Date },
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status === 'deleted') return false;
    Object.assign(row, {
      status: 'deleted',
      deletionReason: input.reason,
      deletedAt: input.deletedAt,
      eraseAfter: input.eraseAfter,
    });
    return true;
  }

  async listBySubject(subject: FileSubject, purposes: readonly Purpose[], limit: number) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.status === 'available' && purposes.includes(row.purpose) && sameSubject(row.subject, subject),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async countPending(ownerId: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.ownerId === ownerId && row.status === 'pending')
      .length;
  }

  async declaredBytesSince(ownerId: string, since: Date): Promise<number> {
    return [...this.rows.values()]
      .filter((row) => row.ownerId === ownerId && row.createdAt >= since)
      .reduce((sum, row) => sum + row.sizeBytes, 0);
  }

  async expirePending(input: { createdBefore: Date; now: Date; limit: number }): Promise<number> {
    const rows = [...this.rows.values()]
      .filter((row) => row.status === 'pending' && row.createdAt < input.createdBefore)
      .slice(0, input.limit);
    for (const row of rows) this.markDeleted(row, 'upload_expired', input.now);
    return rows.length;
  }

  async expireUnattached(input: { completedBefore: Date; now: Date; limit: number }): Promise<number> {
    const rows = [...this.rows.values()]
      .filter(
        (row) =>
          row.status === 'available' &&
          row.subject === null &&
          row.completedAt !== null &&
          row.completedAt < input.completedBefore,
      )
      .slice(0, input.limit);
    for (const row of rows) this.markDeleted(row, 'never_attached', input.now);
    return rows.length;
  }

  async listToErase(now: Date, limit: number): Promise<StoredFile[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          (row.status === 'deleted' || row.status === 'rejected') &&
          row.eraseAfter !== null &&
          row.eraseAfter <= now,
      )
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async remove(id: string, now: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row?.eraseAfter && row.eraseAfter <= now) this.rows.delete(id);
  }

  async eraseAccount(
    userId: string,
    input: { eventId: string; consumer: string; erasedPurposes: readonly Purpose[]; now: Date },
  ): Promise<AccountErasure> {
    const key = `${input.eventId}:${input.consumer}`;
    if (this.processedEvents.has(key)) return { status: 'duplicate', erased: 0, detached: 0 };
    this.processedEvents.add(key);
    let erased = 0;
    let detached = 0;
    for (const row of this.rows.values()) {
      if (row.ownerId !== userId) continue;
      const erase =
        row.status !== 'deleted' &&
        (row.status === 'pending' || row.subject === null || input.erasedPurposes.includes(row.purpose));
      if (erase) {
        this.markDeleted(row, 'account_deleted', input.now);
        erased += 1;
      } else if (row.status !== 'deleted') {
        detached += 1;
      }
      row.ownerId = null;
      row.fileName = neutralFileName(row);
    }
    return { status: 'processed', erased, detached };
  }

  private markDeleted(row: StoredFile, reason: StoredFile['deletionReason'], now: Date): void {
    Object.assign(row, { status: 'deleted', deletionReason: reason, deletedAt: now, eraseAfter: now });
  }
}

/** Stockage en mémoire : les adresses présignées sont factices mais déterministes. */
export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  readonly removed: string[] = [];
  down = false;

  put(key: string, bytes: Uint8Array, contentType: string | null): void {
    this.objects.set(key, { bytes, contentType });
  }

  async presignUpload(
    key: string,
    input: { contentType: string; sizeBytes: number; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    return {
      url: `https://storage.test/ksp-files/${key}?X-Amz-Expires=${input.expiresInSeconds}&put`,
      headers: { 'Content-Type': input.contentType },
    };
  }

  async presignDownload(
    key: string,
    input: { fileName: string; contentType: string; expiresInSeconds: number },
  ): Promise<string> {
    return `https://storage.test/ksp-files/${key}?X-Amz-Expires=${input.expiresInSeconds}&get`;
  }

  async stat(key: string): Promise<ObjectStat | null> {
    this.failIfDown();
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.bytes.length, contentType: object.contentType } : null;
  }

  async readHead(key: string, bytes: number): Promise<Uint8Array> {
    this.failIfDown();
    return (this.objects.get(key)?.bytes ?? new Uint8Array()).slice(0, bytes);
  }

  async remove(key: string): Promise<void> {
    this.failIfDown();
    this.objects.delete(key);
    this.removed.push(key);
  }

  private failIfDown(): void {
    if (this.down) throw FileErrors.storageUnavailable();
  }
}

export class FakeScanner implements MalwareScanner {
  verdict: 'clean' | 'infected' | 'skipped' = 'skipped';

  async scan(): Promise<'clean' | 'infected' | 'skipped'> {
    return this.verdict;
  }
}

export const SETTINGS: FileSettings = {
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 300,
  pendingTtlMinutes: 24 * 60,
  unattachedTtlHours: 24,
  eraseDelayHours: 168,
  maxPendingPerOwner: 3,
  dailyBytesPerOwner: 20 * 1024 * 1024,
};

export function testDeps(overrides: Partial<FileSettings> = {}) {
  const files = new InMemoryFileRepository();
  const storage = new FakeObjectStorage();
  const scanner = new FakeScanner();
  const clock = new FixedClock();
  const deps: FileDeps = {
    files,
    storage,
    scanner,
    clock,
    ids: new SequenceIds(),
    settings: { ...SETTINGS, ...overrides },
  };
  return { deps, files, storage, scanner, clock };
}

/** Appel au nom d'un compte connecté, relayé par la gateway. */
export function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      correlationId: 'c-test',
      callerService: 'gateway',
      user: { userId, sessionId: 's-test', activeContext: 'personal', roles: [], mfa: false },
    },
    fn,
  );
}

/** Appel d'un service métier (jeton de service vérifié). */
export function asService<T>(service: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ correlationId: 'c-test', callerService: service }, fn);
}
