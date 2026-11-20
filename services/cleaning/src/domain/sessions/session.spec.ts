import { assertTeamMember } from './session';
import { fieldSession } from './testing';

describe('seuls les agents affectés exécutent la séance (R-EX-01)', () => {
  it('un agent affecté agit ; un agent désaffecté ou inconnu ne voit pas la séance', () => {
    const session = fieldSession();
    expect(() => assertTeamMember(session, 'agent-2', false)).not.toThrow();
    expect(() => assertTeamMember(session, 'agent-9', false)).toThrow(
      expect.objectContaining({ code: 'CLEANING_SESSION_NOT_FOUND' }),
    );
  });
});

describe('le chef d’équipe démarre et clôture (R-EQ-03)', () => {
  it('chef d’équipe : accepté ; autre membre : CLEANING_TEAM_LEAD_ONLY', () => {
    const session = fieldSession();
    expect(() => assertTeamMember(session, 'agent-1', true)).not.toThrow();
    expect(() => assertTeamMember(session, 'agent-2', true)).toThrow(
      expect.objectContaining({ code: 'CLEANING_TEAM_LEAD_ONLY' }),
    );
  });

  it('cas limite : un agent seul, même sans la marque de chef, conduit sa séance', () => {
    const session = fieldSession({ agents: [{ agentId: 'agent-2', isLead: false }] });
    expect(() => assertTeamMember(session, 'agent-2', true)).not.toThrow();
  });
});
