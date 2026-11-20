import type { FieldSession } from './session';

/**
 * Jeu d'essai des tests de séance : lundi 23 novembre 2026, 9 h – 11 h à Porto-Novo (8 h – 10 h
 * UTC), deux agents dont un chef d'équipe, un point commun et un point du type « sol ».
 */
export function fieldSession(overrides: Partial<FieldSession> = {}): FieldSession {
  return {
    id: 'session-3',
    status: 'assigned',
    scheduledStart: new Date('2026-11-23T09:00:00+01:00'),
    scheduledEnd: new Date('2026-11-23T11:00:00+01:00'),
    agents: [
      { agentId: 'agent-1', isLead: true },
      { agentId: 'agent-2', isLead: false },
    ],
    arrivedAt: null,
    arrival: null,
    startedAt: null,
    completedAt: null,
    checklist: [
      {
        cleaningTypeCode: null,
        code: 'accueil',
        label: 'Accueil du client',
        checked: false,
        checkedAt: null,
      },
      { cleaningTypeCode: 'sol', code: 'lavage', label: 'Lavage des sols', checked: false, checkedAt: null },
    ],
    beforePhotoFileIds: [],
    afterPhotoFileIds: [],
    incidents: [],
    missed: null,
    signatureFileId: null,
    staffClosure: null,
    ...overrides,
  };
}
