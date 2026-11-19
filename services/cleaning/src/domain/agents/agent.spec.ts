import {
  AGENT_STATUSES,
  type AgentStatus,
  canTransitionAgent,
  checkDeactivation,
  transitionAgent,
  validatedSkillCodes,
} from './agent';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T08:00:00+01:00');

/** Transitions de 15.2, recopiées telles quelles : toute autre est interdite. */
const ALLOWED: [AgentStatus, AgentStatus][] = [
  ['applicant', 'under_review'],
  ['under_review', 'active'],
  ['under_review', 'rejected'],
  ['active', 'suspended'],
  ['suspended', 'active'],
  ['suspended', 'deactivated'],
];

describe('agent : transitions de statut (9.1, 15.2)', () => {
  it('chaque transition de 15.2 est permise', () => {
    for (const [from, to] of ALLOWED) {
      expect(canTransitionAgent(from, to)).toBe(true);
      expect(transitionAgent(from, to, 'motif')).toEqual({ ok: true, value: to });
    }
  });

  it('toute autre transition répond CLEANING_INVALID_TRANSITION, avec from et to', () => {
    for (const from of AGENT_STATUSES) {
      for (const to of AGENT_STATUSES) {
        if (ALLOWED.some(([a, b]) => a === from && b === to)) continue;
        expect(canTransitionAgent(from, to)).toBe(false);
        expect(transitionAgent(from, to, 'motif')).toEqual({
          ok: false,
          errors: [{ code: 'CLEANING_INVALID_TRANSITION', details: { from, to } }],
        });
      }
    }
  });

  it('cas limites : candidat refusé sans vérification, actif désactivé sans suspension, retour d’un refusé', () => {
    expect(canTransitionAgent('applicant', 'rejected')).toBe(false);
    expect(canTransitionAgent('active', 'deactivated')).toBe(false);
    expect(canTransitionAgent('rejected', 'under_review')).toBe(false);
    expect(canTransitionAgent('deactivated', 'active')).toBe(false);
  });

  it('un refus exige un motif non vide', () => {
    expect(transitionAgent('under_review', 'rejected', null)).toEqual({
      ok: false,
      errors: [{ code: 'CLEANING_REASON_REQUIRED', details: { field: 'reason' } }],
    });
    expect(transitionAgent('under_review', 'rejected', '   ')).toEqual({
      ok: false,
      errors: [{ code: 'CLEANING_REASON_REQUIRED', details: { field: 'reason' } }],
    });
    expect(transitionAgent('under_review', 'active', null)).toEqual({ ok: true, value: 'active' });
  });
});

describe('agent : compétences validées (R-AG-01)', () => {
  it('seules les compétences validées comptent', () => {
    expect(
      validatedSkillCodes([
        { code: 'interior', status: 'validated' },
        { code: 'pool', status: 'declared' },
        { code: 'height', status: 'rejected' },
        { code: 'garden', status: 'validated' },
      ]),
    ).toEqual(new Set(['interior', 'garden']));
  });

  it('aucune compétence validée : ensemble vide', () => {
    expect(validatedSkillCodes([{ code: 'pool', status: 'declared' }])).toEqual(new Set());
    expect(validatedSkillCodes([])).toEqual(new Set());
  });
});

describe('agent : désactivation (R-AG-03)', () => {
  const assignment = (id: string, end: string, status: 'confirmed' | 'removed' = 'confirmed') => ({
    assignmentId: id,
    status,
    respondBefore: null,
    end: at(end),
  });

  it('sans affectation à venir : acceptée', () => {
    expect(
      checkDeactivation({
        assignments: [
          assignment('a1', '2026-11-20T08:00:00+01:00'),
          assignment('a2', '2026-11-25T10:00:00+01:00', 'removed'),
        ],
        reassign: false,
        now: NOW,
      }),
    ).toEqual({ ok: true, value: { toReassign: [] } });
  });

  it('affectations à venir (en cours comprise) : refusée avec leur liste', () => {
    expect(
      checkDeactivation({
        assignments: [
          assignment('a1', '2026-11-20T08:00:01+01:00'),
          assignment('a2', '2026-11-25T10:00:00+01:00'),
        ],
        reassign: false,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      errors: [{ code: 'CLEANING_AGENT_HAS_ASSIGNMENTS', details: { assignments: ['a1', 'a2'] } }],
    });
  });

  it('réaffectation automatique demandée : acceptée, avec les affectations à réaffecter', () => {
    expect(
      checkDeactivation({
        assignments: [assignment('a1', '2026-11-25T10:00:00+01:00')],
        reassign: true,
        now: NOW,
      }),
    ).toEqual({ ok: true, value: { toReassign: ['a1'] } });
  });
});
