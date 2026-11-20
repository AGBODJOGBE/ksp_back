import { addSessionPhoto, arriveAtSession, startSession, updateChecklist } from './field-steps';
import { fieldSession } from './testing';

const at = (iso: string) => new Date(iso);
const PLACE = { latitude: 6.4969, longitude: 2.6289, accuracyMeters: 20 };
const SETTINGS = { arrivalMaxAdvanceMinutes: 30, arrivalAlertMeters: 300 };

describe('arrivée (partie 10)', () => {
  const arrive = (now: string, extra: Partial<Parameters<typeof arriveAtSession>[1]> = {}) =>
    arriveAtSession(fieldSession(), {
      agentId: 'agent-1',
      now: at(now),
      position: { ...PLACE, accuracyMeters: 8 },
      place: PLACE,
      settings: SETTINGS,
      ...extra,
    });

  it('le chef d’équipe marque l’arrivée 30 min avant pile : heure et contrôle de position gardés', () => {
    const session = arrive('2026-11-23T08:30:00+01:00');
    expect(session.status).toBe('assigned');
    expect(session.arrivedAt).toEqual(at('2026-11-23T07:30:00Z'));
    expect(session.arrival).toMatchObject({ distanceMeters: 0, alert: false, arrivalAccuracyMeters: 8 });
  });

  it('31 min avant : CLEANING_SESSION_TOO_EARLY ; hors connexion, l’heure réelle compte', () => {
    expect(() => arrive('2026-11-23T08:29:00+01:00')).toThrow(
      expect.objectContaining({ code: 'CLEANING_SESSION_TOO_EARLY' }),
    );
    expect(() =>
      arrive('2026-11-23T10:00:00+01:00', { occurredAt: at('2026-11-23T08:29:00+01:00') }),
    ).toThrow(expect.objectContaining({ code: 'CLEANING_SESSION_TOO_EARLY' }));
  });

  it('un membre non chef : CLEANING_TEAM_LEAD_ONLY ; séance en cours : CLEANING_INVALID_TRANSITION', () => {
    expect(() => arrive('2026-11-23T09:00:00+01:00', { agentId: 'agent-2' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_TEAM_LEAD_ONLY' }),
    );
    expect(() =>
      arriveAtSession(fieldSession({ status: 'in_progress' }), {
        agentId: 'agent-1',
        now: at('2026-11-23T09:00:00+01:00'),
        position: null,
        place: PLACE,
        settings: SETTINGS,
      }),
    ).toThrow(expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }));
  });

  it('une seconde arrivée garde la première', () => {
    const first = arrive('2026-11-23T08:45:00+01:00');
    const again = arriveAtSession(first, {
      agentId: 'agent-1',
      now: at('2026-11-23T09:10:00+01:00'),
      position: null,
      place: PLACE,
      settings: SETTINGS,
    });
    expect(again).toBe(first);
  });
});

describe('photos « avant » et « après » (partie 10, R-EX-07)', () => {
  const NOW = at('2026-11-23T09:05:00+01:00');
  const add = (
    session = fieldSession(),
    kind: 'before' | 'after' = 'before',
    fileId = 'f-1',
    agentId = 'agent-2',
  ) => addSessionPhoto(session, { agentId, kind, fileId, now: NOW, maxPerKind: 10 });

  it('tout agent affecté dépose une photo « avant » tant que la séance n’a pas démarré', () => {
    expect(add().beforePhotoFileIds).toEqual(['f-1']);
    expect(() => add(fieldSession({ status: 'in_progress' }))).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });

  it('photo « après » pendant la séance seulement', () => {
    const running = fieldSession({ status: 'in_progress' });
    expect(add(running, 'after').afterPhotoFileIds).toEqual(['f-1']);
    expect(() => add(fieldSession(), 'after')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });

  it('10 photos pile : la 11e est refusée (CLEANING_PHOTO_LIMIT_REACHED)', () => {
    const nine = Array.from({ length: 9 }, (_, index) => `b-${index}`);
    const ten = add(fieldSession({ beforePhotoFileIds: nine }), 'before', 'b-9');
    expect(ten.beforePhotoFileIds).toHaveLength(10);
    expect(() => add(ten, 'before', 'b-10')).toThrow(
      expect.objectContaining({
        code: 'CLEANING_PHOTO_LIMIT_REACHED',
        details: { kind: 'before', maximum: 10 },
      }),
    );
  });

  it('un ajout en double est sans effet ; un fichier n’a qu’un seul type', () => {
    const once = add();
    expect(add(once)).toBe(once);
    const running = fieldSession({ status: 'in_progress', beforePhotoFileIds: ['f-1'] });
    expect(() => add(running, 'after', 'f-1')).toThrow(
      expect.objectContaining({ details: { field: 'fileId', reason: 'photo_kind_conflict' } }),
    );
  });

  it('agent non affecté : CLEANING_SESSION_NOT_FOUND', () => {
    expect(() => add(fieldSession(), 'before', 'f-1', 'agent-9')).toThrow(
      expect.objectContaining({ code: 'CLEANING_SESSION_NOT_FOUND' }),
    );
  });
});

describe('démarrage (partie 10, R-EQ-03, R-PP-04)', () => {
  const ready = fieldSession({ beforePhotoFileIds: ['f-1'], arrivedAt: at('2026-11-23T08:50:00+01:00') });
  const start = (session = ready, extra: Partial<Parameters<typeof startSession>[1]> = {}) =>
    startSession(session, {
      agentId: 'agent-1',
      now: at('2026-11-23T09:02:00+01:00'),
      payment: null,
      ...extra,
    });

  it('chef d’équipe, une photo « avant » : la séance passe « en cours »', () => {
    expect(start()).toMatchObject({ status: 'in_progress', startedAt: at('2026-11-23T08:02:00Z') });
  });

  it('sans photo « avant » : CLEANING_PHOTOS_MISSING', () => {
    expect(() => start(fieldSession())).toThrow(
      expect.objectContaining({ code: 'CLEANING_PHOTOS_MISSING', details: { kind: 'before' } }),
    );
  });

  it('heure réelle avant l’arrivée : refusée ; égale à l’arrivée : acceptée', () => {
    expect(() => start(ready, { occurredAt: at('2026-11-23T08:49:59+01:00') })).toThrow(
      expect.objectContaining({ details: { field: 'occurredAt', reason: 'out_of_range' } }),
    );
    expect(start(ready, { occurredAt: at('2026-11-23T08:50:00+01:00') }).status).toBe('in_progress');
  });

  it('séance précédente en retard : CLEANING_SESSION_OVERDUE_PAYMENT', () => {
    const payment = {
      payerKind: 'individual' as const,
      programSessions: [{ sessionId: 'session-2', paymentStatus: 'overdue' as const, dueBy: null }],
      balanceGuarantee: false,
      balance: 0,
      expectedAmount: 15_000,
    };
    expect(() => start(ready, { payment })).toThrow(
      expect.objectContaining({ code: 'CLEANING_SESSION_OVERDUE_PAYMENT' }),
    );
  });

  it('membre non chef, ou séance à affecter : refusés', () => {
    expect(() => start(ready, { agentId: 'agent-2' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_TEAM_LEAD_ONLY' }),
    );
    expect(() => start({ ...ready, status: 'to_assign' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });
});

describe('liste de contrôle (partie 10, R-EX-05, R-EX-09)', () => {
  const running = fieldSession({ status: 'in_progress' });
  const NOW = at('2026-11-23T09:40:00+01:00');

  it('un point coché garde son heure réelle ; un point commun a un type vide', () => {
    const session = updateChecklist(running, {
      agentId: 'agent-2',
      now: NOW,
      occurredAt: at('2026-11-23T09:31:00+01:00'),
      items: [{ cleaningTypeCode: null, code: 'accueil', checked: true }],
    });
    expect(session.checklist[0]).toMatchObject({ checked: true, checkedAt: at('2026-11-23T08:31:00Z') });
    expect(session.checklist[1]).toMatchObject({ checked: false, checkedAt: null });
  });

  it('cocher deux fois garde la première heure ; décocher efface l’heure', () => {
    const tick = (session = running, checked = true, now = NOW) =>
      updateChecklist(session, {
        agentId: 'agent-1',
        now,
        items: [{ cleaningTypeCode: 'sol', code: 'lavage', checked }],
      });
    const once = tick();
    expect(tick(once, true, at('2026-11-23T09:50:00+01:00')).checklist[1]?.checkedAt).toEqual(NOW);
    expect(tick(once, false).checklist[1]).toMatchObject({ checked: false, checkedAt: null });
  });

  it('point inconnu (même code, autre type) : CLEANING_VALIDATION_FAILED', () => {
    expect(() =>
      updateChecklist(running, {
        agentId: 'agent-1',
        now: NOW,
        items: [{ cleaningTypeCode: 'sol', code: 'accueil', checked: true }],
      }),
    ).toThrow(
      expect.objectContaining({
        details: { field: 'items', reason: 'not_applicable', cleaningTypeCode: 'sol', code: 'accueil' },
      }),
    );
  });

  it('hors séance en cours : CLEANING_INVALID_TRANSITION', () => {
    expect(() => updateChecklist(fieldSession(), { agentId: 'agent-1', now: NOW, items: [] })).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });
});
