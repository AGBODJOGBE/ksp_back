import { AppError } from '@ksp/platform';
import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { type CleaningServer, NOT_IMPLEMENTED, startCleaningStub } from './support/cleaning-stub';
import {
  type IdentityServer,
  ORIGINS,
  protoIndividual,
  protoUser,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Nettoyage v2 (ADR-054) : le contrôleur commun, produit depuis le contrat. Ce que la gateway
 * transmet à cleaning (champs gRPC, clé d'idempotence, utilisateur), ce qu'elle refuse avant tout
 * appel (corps, paramètres, permission, double authentification, profil), et la traduction des
 * réponses et des erreurs. Toutes les routes sont couvertes par openapi.contract.spec.ts.
 */
const ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1001';
const PLACE_TYPE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d2001';
const KEY = 'cle-0192f1c4-0001';

/** Lieu tel que cleaning le renvoie (chargeur des .proto : champs facultatifs absents, message absent → null). */
const protoPlace = {
  id: ID,
  name: 'Maison de Calavi',
  placeTypeId: PLACE_TYPE_ID,
  placeTypeName: 'Maison',
  communeKey: 'abomey-calavi',
  communeName: 'Abomey-Calavi',
  served: true,
  location: null,
  declaredValues: {
    surface: { number: 120 },
    standing: { choice: 'haut' },
    pets: { flag: false },
  },
  archived: false,
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
};

describe('gateway → cleaning v2 : contrôleur commun des routes du Nettoyage', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let cleaning: CleaningServer;
  let app: NestExpressApplication;
  let unreachable: NestExpressApplication;
  let customer: string;
  let ip = 0;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    cleaning = await startCleaningStub(keys);
    app = await startGateway({ identityUrl: identity.url, cleaningUrl: cleaning.url, keys });
    // Sans service cleaning : connexion refusée.
    unreachable = await startGateway({ identityUrl: identity.url, keys });
    customer = await keys.accessToken();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await unreachable?.close();
    await cleaning?.close();
    await identity?.close();
  });

  beforeEach(() => {
    cleaning.stub.reset();
    identity.stub.reset();
  });

  const http = (target = app) => request(target.getHttpServer());
  const web = (req: request.Test) => req.set('X-Forwarded-For', `192.0.2.${++ip}`).set('Origin', ORIGINS.web);
  const asCustomer = (req: request.Test) => web(req).set('Authorization', `Bearer ${customer}`);
  /** Personnel du back-office : permissions du jeton (partout ou par commune), double authentification. */
  const staff = (claims: { perms?: string[]; zone_perms?: Record<string, string[]>; mfa?: boolean }) =>
    keys.accessToken({
      claims: {
        client_id: 'backoffice',
        roles: [{ role: 'cleaning_supervisor', scopeType: 'domain', scopeId: 'cleaning' }],
        mfa: claims.mfa ?? true,
        ...(claims.perms ? { perms: claims.perms } : {}),
        ...(claims.zone_perms ? { zone_perms: claims.zone_perms } : {}),
      },
    });
  const backoffice = (req: request.Test, bearer: string) =>
    req
      .set('X-Forwarded-For', `192.0.2.${++ip}`)
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${bearer}`);

  describe('route publique', () => {
    it('catalogue sans compte : liste « data » de la réponse REST, champ répété en gRPC', async () => {
      cleaning.stub.on('listCatalog', async () => ({ categories: [] }));
      const res = await web(http().get('/api/v1/cleaning/catalog/place-types')).expect(200);
      expect(res.body).toEqual({ data: [] });
      expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(cleaning.stub.last('listCatalog')?.context?.user).toBeUndefined();
    });

    it('aucun corps accepté sur une route qui n’en déclare pas', async () => {
      const res = await web(http().get('/api/v1/cleaning/catalog/zones'))
        .set('Content-Type', 'application/json')
        .send({ inattendu: true })
        .expect(400);
      expect(res.body.error).toMatchObject({
        code: 'GATEWAY_VALIDATION_FAILED',
        details: { fields: [{ field: '(corps)', reason: 'unknown_field' }] },
      });
      expect(cleaning.stub.calls).toHaveLength(0);
    });
  });

  describe('route du client', () => {
    const body = {
      name: 'Maison de Calavi',
      placeTypeId: PLACE_TYPE_ID,
      latitude: 6.4489,
      longitude: 2.3556,
      landmark: 'Portail bleu après la pharmacie',
      declaredValues: { surface: 120, standing: 'haut', pets: false },
    };

    it('enregistrement d’un lieu : clé d’idempotence, champs et valeurs placés dans le message gRPC', async () => {
      cleaning.stub.on('createPlace', async () => ({ place: protoPlace }));
      const res = await asCustomer(http().post('/api/v1/cleaning/places'))
        .set('Idempotency-Key', KEY)
        .send(body)
        .expect(200);

      const call = cleaning.stub.last('createPlace')!;
      expect(call.service).toBe('PlaceService');
      expect(call.request).toMatchObject({
        idempotencyKey: KEY,
        name: 'Maison de Calavi',
        placeTypeId: PLACE_TYPE_ID,
        latitude: 6.4489,
        longitude: 2.3556,
        // Valeur simple en REST, message ParameterValue (oneof) en gRPC.
        declaredValues: {
          surface: { number: 120 },
          standing: { choice: 'haut' },
          pets: { flag: false },
        },
      });
      // L'utilisateur voyage dans les métadonnées, jamais dans le message.
      expect(call.context?.user?.userId).toBe(USER_ID);

      // Réponse : le seul champ du message (place), champs facultatifs absents → null.
      expect(res.body).toEqual({
        ...protoPlace,
        declaredValues: { surface: 120, standing: 'haut', pets: false },
        location: null,
        locationCorrectedAt: null,
        locationErasedAt: null,
      });
    });

    it('sans Idempotency-Key : refusé avant tout appel', async () => {
      const res = await asCustomer(http().post('/api/v1/cleaning/places')).send(body).expect(400);
      expect(res.body.error.details).toEqual({
        fields: [{ field: 'Idempotency-Key', reason: 'invalid_type' }],
      });
      expect(cleaning.stub.calls).toHaveLength(0);
    });

    it('liste paginée : paramètres de requête convertis, curseur de fin vide → null', async () => {
      cleaning.stub.on('listMyPlaces', async () => ({ items: [protoPlace], nextCursor: '', total: 1 }));
      const res = await asCustomer(http().get('/api/v1/cleaning/places'))
        .query({ limit: '5', archived: 'true', sort: 'name' })
        .expect(200);
      expect(cleaning.stub.last('listMyPlaces')!.request).toMatchObject({
        limit: 5,
        archived: true,
        sort: 'name',
      });
      expect(res.body).toMatchObject({
        data: [{ id: ID, declaredValues: { surface: 120 } }],
        nextCursor: null,
        total: 1,
      });
    });

    it('paramètre de requête invalide : refusé avant tout appel', async () => {
      const res = await asCustomer(http().get('/api/v1/cleaning/places'))
        .query({ limit: 'beaucoup' })
        .expect(400);
      expect(res.body.error).toMatchObject({ code: 'GATEWAY_VALIDATION_FAILED' });
      expect(res.body.error.details.fields[0].field).toBe('limit');
      expect(cleaning.stub.calls).toHaveLength(0);
    });

    it('sans jeton : 401 avant tout appel', async () => {
      await web(http().get('/api/v1/cleaning/places')).expect(401);
      expect(cleaning.stub.calls).toHaveLength(0);
    });
  });

  describe('corps invalide', () => {
    it.each([
      ['un champ inconnu', { surprise: 1 }, 'unknown_field'],
      ['un nombre décimal pour un paramètre entier', { declaredValues: { surface: 120.5 } }, 'invalid_union'],
      ['une latitude sans longitude', { latitude: 6.4, longitude: undefined }, 'custom'],
    ])('refuse %s, sans appeler cleaning', async (_label, change, reason) => {
      const res = await asCustomer(http().patch(`/api/v1/cleaning/places/${ID}`))
        .send({ name: 'Maison', ...change })
        .expect(400);
      expect(res.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
      expect(res.body.error.details.fields.map((field: { reason: string }) => field.reason)).toContain(
        reason,
      );
      expect(cleaning.stub.calls).toHaveLength(0);
    });

    it('refuse un identifiant de chemin mal formé', async () => {
      const res = await asCustomer(http().get('/api/v1/cleaning/places/abc')).expect(400);
      expect(res.body.error.details).toEqual({ fields: [{ field: 'id', reason: 'invalid_format' }] });
    });

    it('corps facultatif absent : seul le paramètre de chemin est transmis', async () => {
      cleaning.stub.on('updatePlace', async () => ({ place: protoPlace }));
      await asCustomer(http().patch(`/api/v1/cleaning/places/${ID}`)).expect(200);
      expect(cleaning.stub.last('updatePlace')!.request).toMatchObject({ placeId: ID });
    });
  });

  describe('route du back-office : permission et double authentification', () => {
    const url = `/api/v1/admin/cleaning/requests/${ID}`;
    const answered = () =>
      cleaning.stub.on('getRequest', () =>
        Promise.reject(AppError.notFound('CLEANING_REQUEST_NOT_FOUND', 'Introuvable.')),
      );

    it('permission absente du jeton : 403 GATEWAY_FORBIDDEN, permission nommée', async () => {
      const res = await backoffice(http().get(url), await staff({ perms: ['cleaning.catalog.read'] })).expect(
        403,
      );
      expect(res.body.error).toMatchObject({
        code: 'GATEWAY_FORBIDDEN',
        details: { permission: 'cleaning.request.read' },
      });
      expect(cleaning.stub.calls).toHaveLength(0);
    });

    it('permission présente mais sans double authentification : 403 GATEWAY_MFA_REQUIRED', async () => {
      const res = await backoffice(
        http().get(url),
        await staff({ perms: ['cleaning.request.read'], mfa: false }),
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('GATEWAY_MFA_REQUIRED');
      expect(cleaning.stub.calls).toHaveLength(0);
    });

    it('permission valable partout : appel transmis, identifiant placé dans requestId', async () => {
      answered();
      await backoffice(http().get(url), await staff({ perms: ['cleaning.request.read'] })).expect(404);
      expect(cleaning.stub.last('getRequest')!.request).toEqual({ requestId: ID });
    });

    it('permission limitée à une commune : transmis, cleaning vérifie la commune du dossier', async () => {
      answered();
      const bearer = await staff({ zone_perms: { 'abomey-calavi': ['cleaning.request.read'] } });
      await backoffice(http().get(url), bearer).expect(404);
      expect(cleaning.stub.last('getRequest')).toBeDefined();
    });

    it('les permissions du jeton sont transmises à cleaning, qui les revérifie (ADR-057, décision 4)', async () => {
      answered();
      const bearer = await staff({
        perms: ['cleaning.catalog.read', 'cleaning.request.read'],
        zone_perms: { 'porto-novo': ['cleaning.request.process'] },
      });
      await backoffice(http().get(url), bearer).expect(404);
      expect(cleaning.stub.last('getRequest')!.context?.user).toMatchObject({
        permissions: ['cleaning.catalog.read', 'cleaning.request.read'],
        zonePermissions: { 'porto-novo': ['cleaning.request.process'] },
      });
    });

    it('les rôles seuls ne suffisent pas : la permission est la seule condition d’accès', async () => {
      const bearer = await keys.accessToken({
        claims: { client_id: 'backoffice', mfa: true, roles: [{ role: 'super_admin', scopeType: 'global' }] },
      });
      await backoffice(http().get(url), bearer).expect(403);
    });

    it('réponse sans corps (204) : jour férié retiré', async () => {
      cleaning.stub.on('deleteHoliday', async () => ({}));
      const res = await backoffice(
        http().delete(`/api/v1/admin/cleaning/holidays/${ID}`),
        await staff({ perms: ['cleaning.catalog.manage'] }),
      ).expect(204);
      expect(res.text).toBe('');
      expect(cleaning.stub.last('deleteHoliday')!.request).toEqual({ holidayId: ID });
    });
  });

  describe('route alias', () => {
    it('l’agent sur place corrige la position par la même méthode gRPC, sans permission au manifeste', async () => {
      cleaning.stub.on('correctRequestLocation', () =>
        Promise.reject(AppError.notFound('CLEANING_REQUEST_NOT_FOUND', 'Dossier introuvable.')),
      );
      const agent = await keys.accessToken({ claims: { perms: ['cleaning.visit.perform'] } });
      await web(http().put(`/api/v1/cleaning/agent/requests/${ID}/location`))
        .set('Authorization', `Bearer ${agent}`)
        .set('Idempotency-Key', KEY)
        .send({ latitude: 6.45, longitude: 2.35, reason: 'Position relevée sur place' })
        .expect(404);
      expect(cleaning.stub.last('correctRequestLocation')!.request).toMatchObject({
        requestId: ID,
        idempotencyKey: KEY,
        latitude: 6.45,
        reason: 'Position relevée sur place',
      });
    });
  });

  describe('profil complet (x-ksp-requires-complete-profile)', () => {
    const submit = () =>
      asCustomer(http().post('/api/v1/cleaning/requests'))
        .set('Idempotency-Key', KEY)
        .send({
          placeId: ID,
          cleaningTypeIds: [PLACE_TYPE_ID],
          values: { surface: 120 },
          schedule: { kind: 'one_off', startTime: '09:00', dates: ['2026-12-01'] },
          visitSlots: [{ start: '2026-11-25T08:00:00.000Z', end: '2026-11-25T10:00:00.000Z' }],
        });

    it('profil incomplet : 422 IDENTITY_PROFILE_INCOMPLETE, cleaning jamais appelé', async () => {
      const res = await submit().expect(422);
      expect(res.body.error.code).toBe('IDENTITY_PROFILE_INCOMPLETE');
      expect(cleaning.stub.calls).toHaveLength(0);
    });

    it('profil complet : la demande est transmise', async () => {
      identity.stub.on('getMe', async () => ({
        user: protoUser,
        profileIncomplete: false,
        activeContext: protoIndividual,
      }));
      const res = await submit();
      expect(res.status).toBe(501);
      expect(cleaning.stub.last('submitRequest')!.request).toMatchObject({
        idempotencyKey: KEY,
        placeId: ID,
        values: { surface: { number: 120 } },
        schedule: { kind: 'one_off', dates: ['2026-12-01'] },
      });
    });
  });

  describe('erreurs de cleaning', () => {
    it('erreur métier : code et détails transmis tels quels', async () => {
      cleaning.stub.on('getMyPlace', () =>
        Promise.reject(
          AppError.notFound('CLEANING_PLACE_NOT_FOUND', 'Ce lieu est introuvable.', { placeId: ID }),
        ),
      );
      const res = await asCustomer(http().get(`/api/v1/cleaning/places/${ID}`)).expect(404);
      expect(res.body.error).toMatchObject({
        code: 'CLEANING_PLACE_NOT_FOUND',
        message: 'Ce lieu est introuvable.',
        details: { placeId: ID },
      });
    });

    it('méthode pas encore livrée par cleaning (UNIMPLEMENTED) : 501, code du service', async () => {
      const res = await asCustomer(http().get(`/api/v1/cleaning/places/${ID}`)).expect(501);
      expect(res.body.error.code).toBe(NOT_IMPLEMENTED);
    });

    it('cleaning injoignable : 503 CLEANING_UNAVAILABLE, sans détail technique', async () => {
      const res = await asCustomer(http(unreachable).get(`/api/v1/cleaning/places/${ID}`)).expect(503);
      expect(res.body.error.code).toBe('CLEANING_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|PlaceService|UNAVAILABLE:/);
    }, 15_000);
  });
});
