import {
  completeSession,
  decidePendingIncident,
  reportCustomerAbsent,
  reportIncident,
  resumeSession,
} from './field-outcomes';
import type { FieldSession } from './session';
import { fieldSession } from './testing';

const at = (iso: string) => new Date(iso);
const running = fieldSession({
  status: 'in_progress',
  startedAt: at('2026-11-23T09:02:00+01:00'),
  beforePhotoFileIds: ['b-1'],
});

describe('incident sur place (partie 10, R-EX-03)', () => {
  const report = (category: 'access' | 'out_of_scope_request' = 'access', note = 'Portail fermé') =>
    reportIncident(running, {
      agentId: 'agent-2',
      incidentId: 'inc-1',
      category,
      note,
      photoFileIds: ['i-1'],
      now: at('2026-11-23T09:30:00+01:00'),
      maxPhotos: 10,
    });

  it('tout agent interrompt la séance avec une note ; le superviseur décide ensuite', () => {
    const { session, amendmentRequired } = report();
    expect(session.status).toBe('interrupted');
    expect(session.incidents).toEqual([
      expect.objectContaining({
        id: 'inc-1',
        category: 'access',
        decision: 'pending',
        reportedBy: 'agent-2',
      }),
    ]);
    expect(amendmentRequired).toBe(false);
  });

  it('demande hors devis : un avenant, jamais un paiement en main propre', () => {
    expect(report('out_of_scope_request').amendmentRequired).toBe(true);
  });

  it('note vide : refusée ; plus de photos que le maximum : refusé', () => {
    expect(() => report('access', '  ')).toThrow(
      expect.objectContaining({ details: { field: 'note', reason: 'required' } }),
    );
    expect(() =>
      reportIncident(running, {
        agentId: 'agent-1',
        incidentId: 'inc-2',
        category: 'other',
        note: 'Coupure',
        photoFileIds: ['a', 'b', 'c'],
        now: at('2026-11-23T09:30:00+01:00'),
        maxPhotos: 2,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CLEANING_PHOTO_LIMIT_REACHED',
        details: { kind: 'incident', maximum: 2 },
      }),
    );
  });

  it('séance pas démarrée : CLEANING_INVALID_TRANSITION', () => {
    expect(() =>
      reportIncident(fieldSession(), {
        agentId: 'agent-1',
        incidentId: 'inc-1',
        category: 'access',
        note: 'x',
        photoFileIds: [],
        now: at('2026-11-23T09:30:00+01:00'),
        maxPhotos: 10,
      }),
    ).toThrow(expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }));
  });

  it('reprise par le superviseur : la séance repasse « en cours », l’incident est décidé', () => {
    const { session } = report();
    const resumed = resumeSession(session, { staffId: 'sup-1', now: at('2026-11-23T09:45:00+01:00') });
    expect(resumed.status).toBe('in_progress');
    expect(resumed.incidents[0]).toMatchObject({ decision: 'resumed', decidedBy: 'sup-1' });
    expect(() => resumeSession(resumed, { staffId: 'sup-1', now: at('2026-11-23T09:46:00+01:00') })).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });

  it('cas limite : une décision ne touche que l’incident en attente', () => {
    const decided = { ...report().session.incidents[0]!, id: 'old', decision: 'resumed' as const };
    const incidents = decidePendingIncident(
      [decided, ...report().session.incidents],
      'cancelled',
      'sup-1',
      at('2026-11-23T10:00:00+01:00'),
    );
    expect(incidents.map((incident) => incident.decision)).toEqual(['resumed', 'cancelled']);
  });
});

describe('clôture (partie 10, R-PP-01)', () => {
  const done = {
    ...running,
    afterPhotoFileIds: ['a-1'],
    checklist: running.checklist.map((point) => ({
      ...point,
      checked: true,
      checkedAt: at('2026-11-23T10:00:00+01:00'),
    })),
  };
  const close = (session: FieldSession = done, extra: Partial<Parameters<typeof completeSession>[1]> = {}) =>
    completeSession(session, { agentId: 'agent-1', now: at('2026-11-23T10:55:00+01:00'), ...extra });

  it('liste complète et photo « après » : séance réalisée, signature facultative', () => {
    expect(close()).toMatchObject({
      status: 'completed',
      completedAt: at('2026-11-23T09:55:00Z'),
      signatureFileId: null,
    });
    expect(close(done, { signatureFileId: 'sig-1' }).signatureFileId).toBe('sig-1');
  });

  it('un point non coché : CLEANING_CHECKLIST_INCOMPLETE avec les points manquants', () => {
    const missing = { ...done, checklist: [done.checklist[0]!, running.checklist[1]!] };
    expect(() => close(missing)).toThrow(
      expect.objectContaining({
        code: 'CLEANING_CHECKLIST_INCOMPLETE',
        details: { missing: [{ cleaningTypeCode: 'sol', code: 'lavage' }] },
      }),
    );
  });

  it('sans photo « après » : CLEANING_PHOTOS_MISSING', () => {
    expect(() => close({ ...done, afterPhotoFileIds: [] })).toThrow(
      expect.objectContaining({ code: 'CLEANING_PHOTOS_MISSING', details: { kind: 'after' } }),
    );
  });

  it('heure réelle avant le démarrage : refusée ; membre non chef : refusé', () => {
    expect(() => close(done, { occurredAt: at('2026-11-23T09:01:59+01:00') })).toThrow(
      expect.objectContaining({ details: { field: 'occurredAt', reason: 'out_of_range' } }),
    );
    expect(() => close(done, { agentId: 'agent-2' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_TEAM_LEAD_ONLY' }),
    );
  });

  it('séance interrompue : l’équipe ne la clôture pas (CLEANING_INVALID_TRANSITION)', () => {
    expect(() => close({ ...done, status: 'interrupted' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });
});

describe('client absent (R-EX-02)', () => {
  const absent = (extra: Partial<Parameters<typeof reportCustomerAbsent>[1]> = {}) =>
    reportCustomerAbsent(fieldSession({ arrivedAt: at('2026-11-23T08:55:00+01:00') }), {
      agentId: 'agent-1',
      now: at('2026-11-23T09:30:00+01:00'),
      cause: 'customer_absent',
      photoFileId: 'p-1',
      waitStartedAt: at('2026-11-23T08:55:00+01:00'),
      calledAt: at('2026-11-23T09:10:00+01:00'),
      waitMinutes: 30,
      ...extra,
    });

  it('après 30 min d’attente pile et un appel tracé, avec une photo du lieu : séance manquée', () => {
    expect(absent()).toMatchObject({
      status: 'missed',
      missed: { cause: 'customer_absent', missedAt: at('2026-11-23T08:30:00Z'), photoFileId: 'p-1' },
    });
  });

  it('une seconde trop tôt : CLEANING_WAIT_TIME_NOT_ELAPSED', () => {
    expect(() => absent({ now: at('2026-11-23T09:29:59+01:00') })).toThrow(
      expect.objectContaining({ code: 'CLEANING_WAIT_TIME_NOT_ELAPSED' }),
    );
  });

  it('sans photo du lieu : refusé ; appel après la déclaration : refusé', () => {
    expect(() => absent({ photoFileId: '' })).toThrow(
      expect.objectContaining({ details: { field: 'photoFileId', reason: 'required' } }),
    );
    expect(() => absent({ calledAt: at('2026-11-23T09:30:01+01:00') })).toThrow(
      expect.objectContaining({ details: { field: 'calledAt', reason: 'out_of_range' } }),
    );
  });

  it('accès impossible : pas d’attente réglée, mais jamais avant l’heure prévue', () => {
    const early = {
      cause: 'access_impossible' as const,
      now: at('2026-11-23T09:00:00+01:00'),
      calledAt: at('2026-11-23T08:56:00+01:00'),
    };
    expect(absent(early).missed?.cause).toBe('access_impossible');
    expect(() => absent({ ...early, now: at('2026-11-23T08:59:59+01:00') })).toThrow(
      expect.objectContaining({ details: { field: 'occurredAt', reason: 'out_of_range' } }),
    );
  });

  it('séance en cours : l’équipe ne la déclare pas manquée', () => {
    expect(() =>
      reportCustomerAbsent(running, {
        agentId: 'agent-1',
        now: at('2026-11-23T09:40:00+01:00'),
        cause: 'customer_absent',
        photoFileId: 'p-1',
        waitStartedAt: at('2026-11-23T09:00:00+01:00'),
        calledAt: at('2026-11-23T09:05:00+01:00'),
        waitMinutes: 30,
      }),
    ).toThrow(expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }));
  });
});
