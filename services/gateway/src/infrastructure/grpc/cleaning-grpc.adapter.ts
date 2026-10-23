import { type Metadata } from '@grpc/grpc-js';
import { type cleaningV1 } from '@ksp/contracts';
import { type AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import {
  type CleaningApi,
  type Json,
  type Page,
  type QuoteInput,
  type QuoteRequestInput,
  type ServiceInput,
  type SettingsInput,
  type SimulationInput,
} from '../../application/cleaning/cleaning.ports';
import {
  presentAgent,
  presentDefinition,
  presentMission,
  presentOffer,
  presentRequest,
  presentSettings,
  presentSimulation,
  presentTeam,
  xof,
} from './cleaning-presenters';
import { toUpstreamError } from './upstream-error';

export interface CleaningClients {
  catalog: cleaningV1.CatalogServiceClient;
  quotes: cleaningV1.QuoteServiceClient;
  missions: cleaningV1.MissionServiceClient;
  admin: cleaningV1.CleaningAdminServiceClient;
}

const page = (value: Page): cleaningV1.Page => ({ limit: value.limit ?? 0, cursor: value.cursor ?? '' });
const list = <T>(items: T[], nextCursor: string) => ({ data: items, nextCursor: nextCursor || null });

/**
 * Client gRPC de cleaning : traduction des messages, délai, coupe-circuit et jeton de service par
 * GrpcCaller. Seules les lectures sont rejouées ; une écriture ne l'est jamais (cahier des charges
 * Gateway, partie 4). Aucun journal du contenu : les demandes portent l'adresse d'intervention.
 */
export class CleaningGrpcAdapter implements CleaningApi {
  private readonly logger = new Logger('CleaningGrpc');

  constructor(
    private readonly clients: CleaningClients,
    private readonly caller: GrpcCaller,
  ) {}

  // --- Catalogue et espace client -------------------------------------------------------------

  async listServices(): Promise<Json> {
    const res = await this.read('listServices', (m) => this.clients.catalog.listServices({}, m));
    return { data: res.services.map(presentOffer) };
  }

  async simulate(input: SimulationInput): Promise<Json> {
    const res = await this.read('simulate', (m) =>
      this.clients.catalog.simulate(
        { ...input, options: input.options ?? [], frequency: input.frequency ?? '' },
        m,
      ),
    );
    return presentSimulation(res);
  }

  async requestQuote(input: QuoteRequestInput, idempotencyKey: string): Promise<Json> {
    const res = await this.write('requestQuote', (m) =>
      this.clients.quotes.requestQuote(
        {
          idempotencyKey,
          serviceCode: input.serviceCode,
          premisesType: input.premisesType,
          quantity: input.quantity,
          options: input.options ?? [],
          commune: input.commune,
          address: input.address,
          preferredSlots: input.preferredSlots,
          comment: input.comment ?? '',
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
          requestedTeamSize: input.requestedTeamSize ?? 0,
        },
        m,
      ),
    );
    return presentRequest(res.request);
  }

  async listMyRequests(value: Page): Promise<Json> {
    const res = await this.read('listMyRequests', (m) =>
      this.clients.quotes.listMyRequests({ page: page(value) }, m),
    );
    return list(res.requests.map(presentRequest), res.nextCursor);
  }

  async getMyRequest(id: string): Promise<Json> {
    return presentRequest(
      (await this.read('getRequest', (m) => this.clients.quotes.getRequest({ requestId: id }, m))).request,
    );
  }

  async acceptQuote(
    id: string,
    input: { slotStart: string; paymentPlan: { option: string; timing: string; method: string } },
    idempotencyKey: string,
  ): Promise<Json> {
    const res = await this.write('acceptQuote', (m) =>
      this.clients.quotes.acceptQuote(
        { requestId: id, idempotencyKey, slotStart: input.slotStart, paymentPlan: input.paymentPlan },
        m,
      ),
    );
    return { request: presentRequest(res.request), mission: presentMission(res.mission) };
  }

  async declineQuote(id: string, reason: string | undefined): Promise<Json> {
    const res = await this.write('declineQuote', (m) =>
      this.clients.quotes.declineQuote({ requestId: id, reason: reason ?? '' }, m),
    );
    return presentRequest(res.request);
  }

  async cancelRequest(id: string, reason: string | undefined): Promise<Json> {
    const res = await this.write('cancelRequest', (m) =>
      this.clients.quotes.cancelRequest({ requestId: id, reason: reason ?? '' }, m),
    );
    return presentRequest(res.request);
  }

  async listMyMissions(value: Page): Promise<Json> {
    const res = await this.read('listMyMissions', (m) =>
      this.clients.missions.listMyMissions({ page: page(value) }, m),
    );
    return list(res.missions.map(presentMission), res.nextCursor);
  }

  async getMyMission(id: string): Promise<Json> {
    return presentMission(
      (await this.read('getMission', (m) => this.clients.missions.getMission({ missionId: id }, m))).mission,
    );
  }

  async cancelMyMission(id: string, reason: string | undefined): Promise<Json> {
    const res = await this.write('cancelMission', (m) =>
      this.clients.missions.cancelMission({ missionId: id, reason: reason ?? '' }, m),
    );
    return presentMission(res.mission);
  }

  // --- Back-office ------------------------------------------------------------------------------

  async listQuoteRequests(value: Page, status: string | undefined): Promise<Json> {
    const res = await this.read('listQuoteRequests', (m) =>
      this.clients.admin.listQuoteRequests({ page: page(value), status: status ?? '' }, m),
    );
    return list(res.requests.map(presentRequest), res.nextCursor);
  }

  async getQuoteRequest(id: string): Promise<Json> {
    return presentRequest(
      (await this.read('getQuoteRequest', (m) => this.clients.admin.getQuoteRequest({ requestId: id }, m)))
        .request,
    );
  }

  async rejectQuoteRequest(id: string, reason: string): Promise<Json> {
    return presentRequest(
      (
        await this.write('rejectQuoteRequest', (m) =>
          this.clients.admin.rejectQuoteRequest({ requestId: id, reason }, m),
        )
      ).request,
    );
  }

  async scheduleVisit(id: string, input: { scheduledAt: string; agentId: string }): Promise<Json> {
    return presentRequest(
      (
        await this.write('scheduleVisit', (m) =>
          this.clients.admin.scheduleVisit({ requestId: id, ...input }, m),
        )
      ).request,
    );
  }

  async completeVisit(visitId: string, report: string): Promise<Json> {
    return presentRequest(
      (await this.write('completeVisit', (m) => this.clients.admin.completeVisit({ visitId, report }, m)))
        .request,
    );
  }

  async sendQuote(id: string, input: QuoteInput): Promise<Json> {
    const res = await this.write('sendQuote', (m) =>
      this.clients.admin.sendQuote(
        {
          requestId: id,
          lines: (input.lines ?? []).map((l) => ({
            label: l.label,
            quantity: l.quantity,
            unitPrice: xof(l.unitPrice),
            amount: xof(l.quantity * l.unitPrice),
          })),
          proposedSlots: input.proposedSlots,
          validityDays: input.validityDays ?? 0,
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
          teamSize: input.teamSize ?? 0,
          durationMinutes: input.durationMinutes,
        },
        m,
      ),
    );
    return presentRequest(res.request);
  }

  async listMissions(value: Page, status: string | undefined): Promise<Json> {
    const res = await this.read('listMissions', (m) =>
      this.clients.admin.listMissions({ page: page(value), status: status ?? '' }, m),
    );
    return list(res.missions.map(presentMission), res.nextCursor);
  }

  async getMission(id: string): Promise<Json> {
    return presentMission(
      (await this.read('getMissionDetail', (m) => this.clients.admin.getMissionDetail({ missionId: id }, m)))
        .mission,
    );
  }

  async scheduleIntervention(
    id: string,
    input: {
      scheduledStart: string;
      durationMinutes: number;
      agentIds?: string[] | undefined;
      teamId?: string | undefined;
    },
  ): Promise<Json> {
    const res = await this.write('scheduleIntervention', (m) =>
      this.clients.admin.scheduleIntervention(
        {
          missionId: id,
          scheduledStart: input.scheduledStart,
          durationMinutes: input.durationMinutes,
          agentIds: input.agentIds ?? [],
          teamId: input.teamId ?? '',
        },
        m,
      ),
    );
    return presentMission(res.mission);
  }

  async recordPayment(
    id: string,
    input: { amount: number; method: string; reference?: string | undefined },
  ): Promise<Json> {
    const res = await this.write('recordPayment', (m) =>
      this.clients.admin.recordPayment(
        { missionId: id, amount: xof(input.amount), method: input.method, reference: input.reference ?? '' },
        m,
      ),
    );
    return presentMission(res.mission);
  }

  async cancelMission(id: string, reason: string): Promise<Json> {
    const res = await this.write('cancelMissionAsSupervisor', (m) =>
      this.clients.admin.cancelMissionAsSupervisor({ missionId: id, reason }, m),
    );
    return presentMission(res.mission);
  }

  async startIntervention(id: string): Promise<Json> {
    return presentMission(
      (
        await this.write('startIntervention', (m) =>
          this.clients.admin.startIntervention({ interventionId: id }, m),
        )
      ).mission,
    );
  }

  async updateChecklist(id: string, doneCodes: string[]): Promise<Json> {
    return presentMission(
      (
        await this.write('updateChecklist', (m) =>
          this.clients.admin.updateChecklist({ interventionId: id, doneCodes }, m),
        )
      ).mission,
    );
  }

  async reportIncident(id: string, note: string): Promise<Json> {
    return presentMission(
      (
        await this.write('reportIncident', (m) =>
          this.clients.admin.reportIncident({ interventionId: id, note }, m),
        )
      ).mission,
    );
  }

  async resumeIntervention(id: string): Promise<Json> {
    return presentMission(
      (
        await this.write('resumeIntervention', (m) =>
          this.clients.admin.resumeIntervention({ interventionId: id }, m),
        )
      ).mission,
    );
  }

  async completeIntervention(id: string): Promise<Json> {
    return presentMission(
      (
        await this.write('completeIntervention', (m) =>
          this.clients.admin.completeIntervention({ interventionId: id }, m),
        )
      ).mission,
    );
  }

  async getCatalog(): Promise<Json> {
    const res = await this.read('getCatalog', (m) => this.clients.admin.getCatalog({}, m));
    return { services: res.services.map(presentDefinition), settings: presentSettings(res.settings) };
  }

  async saveService(code: string, input: ServiceInput): Promise<Json> {
    const p = input.pricing;
    const res = await this.write('saveService', (m) =>
      this.clients.admin.saveService(
        {
          service: {
            code,
            name: input.name,
            description: input.description ?? '',
            unit: input.unit,
            active: input.active,
            pricing: {
              version: 0,
              ...(p.unitPrice === null ? {} : { unitPrice: xof(p.unitPrice) }),
              ...(p.minimumPrice === null ? {} : { minimumPrice: xof(p.minimumPrice) }),
              options: (p.options ?? []).map((o) => ({
                code: o.code,
                label: o.label,
                ...(o.price === null ? {} : { price: xof(o.price) }),
              })),
              communeCoefficients: p.communeCoefficients ?? [],
              defaultCoefficientBp: p.defaultCoefficientBp ?? 0,
              ...(p.teamSize ? { teamSize: p.teamSize } : {}),
              checklist: (p.checklist ?? []).map((item) => ({ ...item, done: false })),
              updatedBy: '',
              updatedAt: '',
            },
          },
        },
        m,
      ),
    );
    return presentDefinition(res.service);
  }

  async updateSettings(input: SettingsInput): Promise<Json> {
    const res = await this.write('updateSettings', (m) =>
      this.clients.admin.updateSettings({ settings: { ...input, updatedBy: '', updatedAt: '' } }, m),
    );
    return presentSettings(res.settings);
  }

  async listAgents(): Promise<Json> {
    const res = await this.read('listAgents', (m) => this.clients.admin.listAgents({}, m));
    return { data: res.agents.map(presentAgent) };
  }

  async registerAgent(input: { agentId: string; displayName: string }): Promise<Json> {
    return presentAgent(
      (await this.write('registerAgent', (m) => this.clients.admin.registerAgent(input, m))).agent,
    );
  }

  async declareUnavailability(
    agentId: string,
    input: { start: string; end: string; reason?: string | undefined },
  ): Promise<Json> {
    const res = await this.write('declareUnavailability', (m) =>
      this.clients.admin.declareUnavailability(
        { agentId, start: input.start, end: input.end, reason: input.reason ?? '' },
        m,
      ),
    );
    return presentAgent(res.agent);
  }

  async listTeams(): Promise<Json> {
    const res = await this.read('listTeams', (m) => this.clients.admin.listTeams({}, m));
    return { data: res.teams.map(presentTeam) };
  }

  async createTeam(input: { name: string; memberIds: string[] }): Promise<Json> {
    return presentTeam((await this.write('createTeam', (m) => this.clients.admin.createTeam(input, m))).team);
  }

  async updateTeam(id: string, input: { name: string; memberIds: string[] }): Promise<Json> {
    return presentTeam(
      (await this.write('updateTeam', (m) => this.clients.admin.updateTeam({ teamId: id, ...input }, m)))
        .team,
    );
  }

  // --- Appels -----------------------------------------------------------------------------------

  private read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, { idempotent: true });
  }

  private write<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, {});
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('cleaning', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`cleaning.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
