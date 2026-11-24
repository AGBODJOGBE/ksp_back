import { completeSessionAsKsp, reportSessionMissedAsKsp } from './staff-closure';
import { fieldSession } from './testing';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-23T15:00:00+01:00');

describe('clôture par le back-office pour l’équipe (R-EX-08)', () => {
  const complete = (
    extra: Partial<Parameters<typeof completeSessionAsKsp>[1]> = {},
    session = fieldSession(),
  ) =>
    completeSessionAsKsp(session, {
      staffId: 'sup-1',
      reason: 'Téléphone du chef d’équipe en panne',
      startedAt: at('2026-11-23T08:30:00+01:00'),
      completedAt: at('2026-11-23T10:30:00+01:00'),
      presentAgentIds: ['agent-1'],
      now: NOW,
      arrivalMaxAdvanceMinutes: 30,
      ...extra,
    });

  it('séance planifiée : réalisée sans photo ni liste, motif et agents présents gardés', () => {
    const { session, claimWindowStartsAt } = complete();
    expect(session).toMatchObject({
      status: 'completed',
      startedAt: at('2026-11-23T07:30:00Z'),
      completedAt: at('2026-11-23T09:30:00Z'),
      staffClosure: {
        closedBy: 'sup-1',
        reason: 'Téléphone du chef d’équipe en panne',
        presentAgentIds: ['agent-1'],
      },
    });
    expect(claimWindowStartsAt).toEqual(NOW);
  });

  it('depuis « en cours » ou « interrompue » aussi ; jamais depuis « à affecter »', () => {
    expect(complete({}, fieldSession({ status: 'interrupted' })).session.status).toBe('completed');
    expect(complete({}, fieldSession({ status: 'in_progress' })).session.status).toBe('completed');
    expect(() => complete({}, fieldSession({ status: 'to_assign' }))).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });

  it('fin égale à maintenant : acceptée ; une milliseconde après : dans le futur', () => {
    expect(complete({ completedAt: NOW }).session.completedAt).toEqual(NOW);
    expect(() => complete({ completedAt: new Date(NOW.getTime() + 1) })).toThrow(
      expect.objectContaining({ details: { field: 'completedAt', reason: 'in_future' } }),
    );
  });

  it('fin égale au début : refusée ; début plus tôt que l’avance maximale : refusé', () => {
    expect(() => complete({ completedAt: at('2026-11-23T08:30:00+01:00') })).toThrow(
      expect.objectContaining({ details: { field: 'completedAt', reason: 'out_of_range' } }),
    );
    expect(() => complete({ startedAt: at('2026-11-23T08:29:59+01:00') })).toThrow(
      expect.objectContaining({ details: { field: 'startedAt', reason: 'out_of_range' } }),
    );
    const noControl = { startedAt: at('2026-11-23T06:00:00+01:00'), arrivalMaxAdvanceMinutes: 0 };
    expect(complete(noControl).session.status).toBe('completed');
  });

  it('motif obligatoire ; agents présents parmi les affectés, au moins un', () => {
    expect(() => complete({ reason: ' ' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_REASON_REQUIRED' }),
    );
    expect(() => complete({ presentAgentIds: [] })).toThrow(
      expect.objectContaining({ details: { field: 'presentAgentIds', reason: 'required' } }),
    );
    expect(() => complete({ presentAgentIds: ['agent-9'] })).toThrow(
      expect.objectContaining({ details: { field: 'presentAgentIds', reason: 'not_applicable' } }),
    );
  });

  it('photos facultatives, ajoutées si elles sont fournies', () => {
    const { session } = complete({ beforePhotoFileIds: ['b-1'], afterPhotoFileIds: ['a-1', 'a-1'] });
    expect(session.beforePhotoFileIds).toEqual(['b-1']);
    expect(session.afterPhotoFileIds).toEqual(['a-1']);
  });
});

describe('absence du client enregistrée par le back-office (R-EX-08)', () => {
  const missed = (
    extra: Partial<Parameters<typeof reportSessionMissedAsKsp>[1]> = {},
    session = fieldSession(),
  ) =>
    reportSessionMissedAsKsp(session, {
      staffId: 'sup-1',
      reason: 'Appel du chef d’équipe',
      cause: 'customer_absent',
      missedAt: at('2026-11-23T09:40:00+01:00'),
      presentAgentIds: ['agent-1', 'agent-2'],
      now: NOW,
      ...extra,
    });

  it('photo, attente et appel facultatifs : séance manquée', () => {
    expect(missed().session).toMatchObject({
      status: 'missed',
      missed: { cause: 'customer_absent', photoFileId: null, waitStartedAt: null, calledAt: null },
      staffClosure: { closedBy: 'sup-1' },
    });
  });

  it('depuis « en cours » aussi ; jamais depuis « interrompue »', () => {
    expect(missed({}, fieldSession({ status: 'in_progress' })).session.status).toBe('missed');
    expect(() => missed({}, fieldSession({ status: 'interrupted' }))).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });

  it('à l’heure prévue pile : acceptée ; avant : refusée ; dans le futur : refusée', () => {
    expect(missed({ missedAt: at('2026-11-23T09:00:00+01:00') }).session.status).toBe('missed');
    expect(() => missed({ missedAt: at('2026-11-23T08:59:59+01:00') })).toThrow(
      expect.objectContaining({ details: { field: 'missedAt', reason: 'out_of_range' } }),
    );
    expect(() => missed({ missedAt: new Date(NOW.getTime() + 1) })).toThrow(
      expect.objectContaining({ details: { field: 'missedAt', reason: 'in_future' } }),
    );
  });
});
