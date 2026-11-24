import { type cleaningV1 } from '@ksp/contracts';
import {
  type AgentIdDocument,
  type IdDocumentFile,
} from '../../application/agents/agent-id-document.use-case';
import { type TeamRecord } from '../../application/agents/agent.ports';
import { type AgentProfile, type AvailabilityView, weeklyRules } from '../../application/agents/agent-views';
import { type Page } from '../../application/shared/input';

/** Agents, disponibilités et équipes → messages du contrat (chaîne vide ou champ absent : null). */

/**
 * Nom affiché « Prénom Nom » → prénom et nom : le premier mot, puis le reste. Nom et prénom restent
 * dans identity ; cleaning n'en garde qu'une copie d'affichage.
 */
export function splitName(displayName: string): { firstName: string; lastName: string } {
  const [firstName = '', ...rest] = displayName.trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
}

export function toAgent(profile: AgentProfile): cleaningV1.Agent {
  const { agent, stats } = profile;
  return {
    id: agent.id,
    userId: agent.userId,
    status: agent.status,
    ...splitName(agent.displayName),
    // Le téléphone vérifié reste dans identity, qui ne le rend pas à cleaning.
    phone: '',
    ...(profile.photoUrl ? { photoUrl: profile.photoUrl } : {}),
    employmentKind: agent.employmentKind,
    residenceCommuneKey: agent.homeCommuneKey,
    zoneKeys: agent.zoneKeys,
    skills: agent.skills.map((s) => ({ code: s.code, name: s.name, validated: s.status === 'validated' })),
    maxHoursPerDay: agent.maxHoursDay,
    maxHoursPerWeek: agent.maxHoursWeek,
    emergencyContact: profile.emergencyContact ?? { name: '', phone: '' },
    ...(profile.mobileMoneyNumber ? { mobileMoneyNumber: profile.mobileMoneyNumber } : {}),
    hasIdDocument: profile.hasIdDocument,
    stats: {
      sessionsCompleted: stats.sessionsCompleted,
      visitsCompleted: stats.visitsCompleted,
      hoursThisWeek: stats.hoursThisWeek,
      hoursThisMonth: stats.hoursThisMonth,
      ...(agent.ratingCount ? { ratingAverage: agent.ratingSum / agent.ratingCount } : {}),
      ratingsCount: agent.ratingCount,
      openClaims: stats.openClaims,
    },
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export function toAgentPage(page: Page<AgentProfile>): cleaningV1.ListAgentsResponse {
  return { items: page.items.map(toAgent), nextCursor: page.nextCursor ?? '', total: page.total };
}

export function toAvailability(view: AvailabilityView): cleaningV1.Availability {
  return {
    weekly: weeklyRules(view.weekly),
    extraAvailabilities: view.extras.map((e) => ({
      id: e.id,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
    })),
    unavailabilities: view.unavailabilities.map((u) => ({
      id: u.id,
      start: u.start.toISOString(),
      end: u.end.toISOString(),
      kind: u.reason,
      ...(u.note ? { note: u.note } : {}),
      forced: u.forced,
      createdBy: u.createdBy,
      createdAt: u.createdAt.toISOString(),
      ...(u.createdByName ? { createdByName: u.createdByName } : {}),
    })),
    maxHoursPerDay: view.maxHoursPerDay,
    maxHoursPerWeek: view.maxHoursPerWeek,
  };
}

export function toTeam(team: TeamRecord): cleaningV1.Team {
  return {
    id: team.id,
    name: team.name,
    leadAgentId: team.leadAgentId,
    members: team.members.map((m) => ({ agentId: m.agentId, ...splitName(m.displayName), status: m.status })),
    active: team.active,
    createdAt: team.createdAt.toISOString(),
  };
}

// --- Piste A (agents) --------------------------------------------------------------------------

/**
 * `Photo.kind` n'a pas de valeur pour une pièce d'identité : elle est rendue comme une pièce jointe
 * à la candidature (« request »), pour rester dans les valeurs que le contrat énumère.
 */
const ID_DOCUMENT_PHOTO_KIND = 'request';

/** Pièce d'identité (recto, verso) → message du contrat ; adresse absente : fichier non conservé. */
export function toIdDocument(document: AgentIdDocument): cleaningV1.IdDocument {
  const photo = (file: IdDocumentFile): cleaningV1.Photo => ({
    fileId: file.fileId,
    kind: ID_DOCUMENT_PHOTO_KIND,
    takenAt: file.uploadedAt.toISOString(),
    ...(file.url ? { url: file.url } : {}),
    ...(file.urlExpiresAt ? { urlExpiresAt: file.urlExpiresAt.toISOString() } : {}),
  });
  return { front: photo(document.front), back: photo(document.back) };
}
