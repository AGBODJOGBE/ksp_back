import { type PrivacyDeps } from '../deps';
import { type FileSubject } from '../ports';
import { type ExpiredPhotos, type PersonalDataRepository } from './privacy.ports';
import {
  PURGE_BATCH,
  PURGE_MAX_BATCHES,
  PurgeExpiredDataUseCase,
  type PurgeStep,
} from './retention.use-case';

const NOW = new Date('2030-06-03T08:00:00Z');
const CUTOFF = new Date('2029-06-03T08:00:00Z');

const visitPhotos = (id: string, ...fileIds: string[]): ExpiredPhotos => ({
  subject: { type: 'cleaning_visit', id },
  fileIds,
});
const sessionPhotos = (id: string, ...fileIds: string[]): ExpiredPhotos => ({
  subject: { type: 'cleaning_session', id },
  fileIds,
});

/** Dépôt en mémoire : chaque étape rend ses lots dans l'ordre, puis des lots vides. */
class FakeRepository {
  locked = true;
  calls: string[] = [];
  requestLots: { taken: number; requests: number; visitArrivals: number }[] = [];
  sessionLots: { taken: number; sessionArrivals: number }[] = [];
  placeLots: number[] = [];
  idempotencyLots: number[] = [];
  visitPhotoLots: ExpiredPhotos[][] = [];
  sessionPhotoLots: ExpiredPhotos[][] = [];
  erased: ExpiredPhotos[] = [];
  /** Cibles dont la référence ne s'efface pas (une autre photo est apparue). */
  changed = new Set<string>();
  failing = new Set<string>();

  private step<T>(name: string, lots: T[], empty: T, args: unknown[]): Promise<T> {
    this.calls.push(
      `${name}(${args.map((arg) => (arg instanceof Date ? arg.toISOString() : arg)).join(', ')})`,
    );
    if (this.failing.has(name)) return Promise.reject(new Error(`${name} en panne`));
    return Promise.resolve(lots.shift() ?? empty);
  }

  port(): PersonalDataRepository {
    return {
      storedObligations: () => Promise.reject(new Error('hors sujet')),
      eraseAccount: () => Promise.reject(new Error('hors sujet')),
      withPurgeLock: async (work) => {
        if (!this.locked) return false;
        await work();
        return true;
      },
      purgeRequestLocations: (cutoff, now, limit) =>
        this.step('requests', this.requestLots, { taken: 0, requests: 0, visitArrivals: 0 }, [
          cutoff,
          now,
          limit,
        ]),
      purgeSessionArrivals: (cutoff, limit) =>
        this.step('sessions', this.sessionLots, { taken: 0, sessionArrivals: 0 }, [cutoff, limit]),
      purgePlaceLocations: (cutoff, now, limit) =>
        this.step('places', this.placeLots, 0, [cutoff, now, limit]),
      expiredVisitPhotos: (cutoff, limit) =>
        this.step('visitPhotos', this.visitPhotoLots, [], [cutoff, limit]),
      expiredSessionPhotos: (cutoff, limit) =>
        this.step('sessionPhotos', this.sessionPhotoLots, [], [cutoff, limit]),
      erasePhotoReferences: async (photos) => {
        if (this.changed.has(photos.subject.id)) return false;
        this.erased.push(photos);
        return true;
      },
      purgeIdempotencyRecords: (before, limit) =>
        this.step('idempotency', this.idempotencyLots, 0, [before, limit]),
    };
  }
}

function setup(retentionMonths = 12) {
  const repository = new FakeRepository();
  const removed: string[] = [];
  const brokenFiles = new Set<string>();
  const errors: [PurgeStep, string][] = [];
  const deps = {
    personalData: repository.port(),
    moduleSettings: { read: async () => ({ settings: { retentionMonths } }) },
    photos: {
      remove: async (fileId: string, subject: FileSubject) => {
        if (brokenFiles.has(fileId)) throw new Error('file injoignable');
        removed.push(`${subject.type}:${subject.id}:${fileId}`);
      },
    },
    clock: { now: () => NOW },
  } as unknown as PrivacyDeps;
  const useCase = new PurgeExpiredDataUseCase(deps, (step, error) =>
    errors.push([step, (error as Error).message]),
  );
  return { repository, removed, brokenFiles, errors, useCase };
}

const NOTHING = {
  ran: true,
  requestLocations: 0,
  visitArrivals: 0,
  sessionArrivals: 0,
  placeLocations: 0,
  photos: 0,
  idempotencyRecords: 0,
  failed: 0,
};

describe('PurgeExpiredDataUseCase : conservation des positions et des photos (UC-NT-48, R-DP-01)', () => {
  it('un passage : chaque étape reçoit la limite « maintenant − N mois », par lots de 200', async () => {
    const { repository, useCase } = setup();
    await expect(useCase.execute()).resolves.toEqual(NOTHING);
    expect(PURGE_BATCH).toBe(200);
    expect(repository.calls).toEqual([
      `requests(${CUTOFF.toISOString()}, ${NOW.toISOString()}, 200)`,
      `sessions(${CUTOFF.toISOString()}, 200)`,
      `places(${CUTOFF.toISOString()}, ${NOW.toISOString()}, 200)`,
      `visitPhotos(${CUTOFF.toISOString()}, 200)`,
      `sessionPhotos(${CUTOFF.toISOString()}, 200)`,
      'idempotency(2030-05-27T08:00:00.000Z, 200)',
    ]);
  });

  it('la durée est le réglage retentionMonths du back-office', async () => {
    const { repository, useCase } = setup(1);
    await useCase.execute();
    expect(repository.calls[0]).toBe(`requests(2030-05-03T08:00:00.000Z, ${NOW.toISOString()}, 200)`);
  });

  it('une autre réplique tient le verrou : rien n’est fait', async () => {
    const { repository, useCase } = setup();
    repository.locked = false;
    await expect(useCase.execute()).resolves.toEqual({ ...NOTHING, ran: false });
    expect(repository.calls).toEqual([]);
  });

  it('les lots pleins s’enchaînent ; le compte rendu additionne ce qui a été effacé', async () => {
    const { repository, useCase } = setup();
    repository.requestLots = [
      { taken: 200, requests: 190, visitArrivals: 40 },
      { taken: 200, requests: 200, visitArrivals: 0 },
      { taken: 7, requests: 3, visitArrivals: 5 },
    ];
    repository.sessionLots = [{ taken: 2, sessionArrivals: 31 }];
    repository.placeLots = [200, 12];
    repository.idempotencyLots = [200, 200, 45];
    await expect(useCase.execute()).resolves.toEqual({
      ...NOTHING,
      requestLocations: 393,
      visitArrivals: 45,
      sessionArrivals: 31,
      placeLocations: 212,
      idempotencyRecords: 445,
    });
    const count = (name: string) => repository.calls.filter((call) => call.startsWith(`${name}(`)).length;
    expect([count('requests'), count('sessions'), count('places'), count('idempotency')]).toEqual([
      3, 1, 2, 3,
    ]);
  });

  it('un passage s’arrête après 25 lots pleins d’une même étape : le reste attend le passage suivant', async () => {
    const { repository, useCase } = setup();
    repository.placeLots = Array.from({ length: 40 }, () => 200);
    const report = await useCase.execute();
    expect(PURGE_MAX_BATCHES).toBe(25);
    expect(report.placeLocations).toBe(25 * 200);
    expect(repository.calls.filter((call) => call.startsWith('places(')).length).toBe(25);
  });

  it('une étape en échec est comptée et signalée, les suivantes passent', async () => {
    const { repository, errors, useCase } = setup();
    repository.failing.add('requests');
    repository.failing.add('visitPhotos');
    repository.sessionLots = [{ taken: 1, sessionArrivals: 4 }];
    repository.placeLots = [3];
    repository.idempotencyLots = [9];
    await expect(useCase.execute()).resolves.toEqual({
      ...NOTHING,
      sessionArrivals: 4,
      placeLocations: 3,
      idempotencyRecords: 9,
      failed: 2,
    });
    expect(errors).toEqual([
      ['request_locations', 'requests en panne'],
      ['visit_photos', 'visitPhotos en panne'],
    ]);
  });

  it('photos : supprimées chez file d’abord, puis leurs références, sans doublon d’appel', async () => {
    const { repository, removed, useCase } = setup();
    repository.visitPhotoLots = [[visitPhotos('v1', 'a', 'b')]];
    repository.sessionPhotoLots = [[sessionPhotos('s1', 'c', 'd', 'e'), sessionPhotos('s2', 'f')]];
    await expect(useCase.execute()).resolves.toEqual({ ...NOTHING, photos: 6 });
    expect(removed).toEqual([
      'cleaning_visit:v1:a',
      'cleaning_visit:v1:b',
      'cleaning_session:s1:c',
      'cleaning_session:s1:d',
      'cleaning_session:s1:e',
      'cleaning_session:s2:f',
    ]);
    expect(repository.erased.map((photos) => photos.subject.id)).toEqual(['v1', 's1', 's2']);
  });

  it('file en échec sur une photo : sa référence reste, l’erreur est isolée et la cible reprise plus tard', async () => {
    const { repository, removed, brokenFiles, errors, useCase } = setup();
    brokenFiles.add('d');
    repository.sessionPhotoLots = [
      Array.from({ length: PURGE_BATCH }, (_, index) =>
        index === 1 ? sessionPhotos('s-en-echec', 'c', 'd', 'e') : sessionPhotos(`s${index}`, `p${index}`),
      ),
      [sessionPhotos('jamais-lue', 'z')],
    ];
    const report = await useCase.execute();
    expect(report).toEqual({ ...NOTHING, photos: PURGE_BATCH - 1, failed: 1 });
    expect(errors).toEqual([['session_photos', 'file injoignable']]);
    // La photo « c » est partie chez file (suppression rejouable) ; rien n'est retiré de la séance.
    expect(removed).toContain('cleaning_session:s-en-echec:c');
    expect(removed).not.toContain('cleaning_session:s-en-echec:e');
    expect(repository.erased.map((photos) => photos.subject.id)).not.toContain('s-en-echec');
    expect(repository.erased).toHaveLength(PURGE_BATCH - 1);
    // Le lot suivant attend le prochain passage : la cible en échec y reviendrait sans fin.
    expect(repository.calls.filter((call) => call.startsWith('sessionPhotos(')).length).toBe(1);
  });

  it('cible qui a changé entre la lecture et l’écriture : rien n’est compté, elle sera reprise', async () => {
    const { repository, useCase } = setup();
    repository.changed.add('v1');
    repository.visitPhotoLots = [[visitPhotos('v1', 'a'), visitPhotos('v2', 'b')]];
    await expect(useCase.execute()).resolves.toEqual({ ...NOTHING, photos: 1 });
    expect(repository.erased.map((photos) => photos.subject.id)).toEqual(['v2']);
  });

  it('réglages illisibles : le passage échoue sans rien effacer', async () => {
    const { repository, useCase } = setup();
    const deps = {
      personalData: repository.port(),
      moduleSettings: { read: () => Promise.reject(new Error('base injoignable')) },
      clock: { now: () => NOW },
    } as unknown as PrivacyDeps;
    await expect(new PurgeExpiredDataUseCase(deps).execute()).rejects.toThrow('base injoignable');
    expect(repository.calls).toEqual([]);
    await expect(useCase.execute()).resolves.toEqual(NOTHING);
  });
});
