import { type PlanningMode, zoneProblems } from '../../domain/catalog/entries';
import { BASIS_POINTS } from '../../domain/pricing/money';
import { countOpenRequests } from '../../domain/requests/request-status';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { CleaningErrors, throwFirstProblem } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { type Page, pageOf, parsePage, parseSort } from '../shared/paging';
import { auditOf } from './audit';
import { type Zone } from './catalog.ports';
import { codeConflict, type PageInput, trim } from './places.use-cases';

/**
 * UC-NT-29 — Gérer les zones et les frais de visite (partie 4, R-FV-01, R-PL-05, R-ZN-01, R-ZN-03).
 * Une zone ouvre une commune du référentiel de geo (clé inconnue : `unknown_commune` ; geo
 * indisponible : refus, jamais d'enregistrement sans contrôle). Désactiver une zone qui a des
 * dossiers en cours demande une confirmation ; les dossiers vont à leur terme.
 */
export interface ZoneView extends Zone {
  openRequests: number;
  activePrograms: number;
}

export interface ZoneFields {
  name?: string | undefined;
  coefficientBps?: number | undefined;
  visitFeeSurcharge?: number | undefined;
  planningMode?: string | undefined;
}

export interface CommuneOption {
  communeKey: string;
  name: string;
  zoneId: string | null;
  zoneActive: boolean;
}

const TRACED = ['communeKey', 'coefficientBps', 'visitFeeSurcharge', 'planningMode', 'active'];

const snapshot = (zone: Zone) => ({
  communeKey: zone.communeKey,
  name: zone.name,
  coefficientBps: zone.coefficientBps,
  visitFeeSurcharge: zone.visitFeeSurcharge,
  planningMode: zone.planningMode,
  active: zone.active,
});

export class ZonesUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: PageInput): Promise<Page<ZoneView>> {
    requireStaff();
    const page = parsePage(input);
    parseSort(input.sort, ['name']);
    const zones = (await this.deps.zones.listZones()).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const slice = pageOf(zones, page);
    return { ...slice, items: await this.views(slice.items) };
  }

  async create(input: ZoneFields & { idempotencyKey: string; communeKey: string }): Promise<ZoneView> {
    const userId = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'zone.create',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.view(String(response.id)),
      run: async (stub) => {
        const commune = (await this.deps.communes.listCommunes()).find(
          (candidate) => candidate.key === input.communeKey,
        );
        if (!commune) throw CleaningErrors.validation('communeKey', 'unknown_commune');
        const zone: Zone = {
          id: this.deps.ids.next(),
          communeKey: commune.key,
          name: trim(input.name) ?? commune.name,
          coefficientBps: input.coefficientBps ?? BASIS_POINTS,
          visitFeeSurcharge: input.visitFeeSurcharge ?? null,
          planningMode: (trim(input.planningMode) as PlanningMode | null) ?? null,
          active: true,
          updatedAt: now,
          updatedBy: userId,
        };
        throwFirstProblem(zoneProblems(zone));
        const audit = auditOf({
          actorId: userId,
          action: 'zone.created',
          entityType: 'zone',
          entityId: zone.id,
          at: now,
          before: null,
          after: snapshot(zone),
          traced: TRACED,
        });
        try {
          await this.deps.zones.saveZone(zone, 'create', {
            events: [],
            audit: [audit],
            idempotency: stub({ id: zone.id }),
          });
        } catch (error) {
          throw codeConflict(error, zone.communeKey);
        }
        return this.view(zone.id);
      },
    });
  }

  /** Un nouveau coefficient ou une nouvelle majoration s'applique aux nouvelles demandes. */
  async update(input: ZoneFields & { zoneId: string }): Promise<ZoneView> {
    const userId = requireStaff();
    const before = await this.zone(input.zoneId);
    const now = this.deps.clock.now();
    const after: Zone = {
      ...before,
      ...(input.name !== undefined ? { name: trim(input.name) ?? '' } : {}),
      ...(input.coefficientBps !== undefined ? { coefficientBps: input.coefficientBps } : {}),
      ...(input.visitFeeSurcharge !== undefined ? { visitFeeSurcharge: input.visitFeeSurcharge } : {}),
      ...(input.planningMode !== undefined
        ? { planningMode: trim(input.planningMode) as PlanningMode | null }
        : {}),
      updatedAt: now,
      updatedBy: userId,
    };
    throwFirstProblem(zoneProblems(after));
    const audit = auditOf({
      actorId: userId,
      action: 'zone.updated',
      entityType: 'zone',
      entityId: after.id,
      at: now,
      before: snapshot(before),
      after: snapshot(after),
      traced: TRACED,
    });
    await this.deps.zones.saveZone(after, 'update', { events: [], audit: [audit] });
    return this.view(after.id);
  }

  async setActive(input: {
    zoneId: string;
    idempotencyKey: string;
    active: boolean;
    confirm?: boolean | undefined;
  }): Promise<ZoneView> {
    const userId = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'zone.set_active',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.view(String(response.id)),
      run: async (stub) => {
        const zone = await this.zone(input.zoneId);
        if (zone.active === input.active) return this.view(zone.id);
        const [view] = await this.views([zone]);
        const { openRequests, activePrograms } = view as ZoneView;
        const confirmed = input.confirm ?? false;
        if (!input.active && (openRequests || activePrograms) && !confirmed) {
          throw CleaningErrors.zoneHasActivity(openRequests, activePrograms);
        }
        const after: Zone = { ...zone, active: input.active, updatedAt: now, updatedBy: userId };
        await this.deps.zones.saveZone(after, 'update', {
          events: [],
          audit: [
            {
              actorId: userId,
              action: 'zone.activation_changed',
              entityType: 'zone',
              entityId: zone.id,
              at: now,
              details: {
                communeKey: zone.communeKey,
                active: input.active,
                openRequests,
                activePrograms,
                confirmed,
              },
            },
          ],
          idempotency: stub({ id: zone.id }),
        });
        return { ...after, openRequests, activePrograms };
      },
    });
  }

  /** Communes du référentiel de geo, avec leur zone (R-ZN-03). */
  async listCommunes(): Promise<CommuneOption[]> {
    requireStaff();
    const [communes, zones] = await Promise.all([
      this.deps.communes.listCommunes(),
      this.deps.zones.listZones(),
    ]);
    const byKey = new Map(zones.map((zone) => [zone.communeKey, zone]));
    return communes.map((commune) => {
      const zone = byKey.get(commune.key);
      return {
        communeKey: commune.key,
        name: commune.name,
        zoneId: zone?.id ?? null,
        zoneActive: zone?.active ?? false,
      };
    });
  }

  private async zone(id: string): Promise<Zone> {
    const zone = await this.deps.zones.getZone(id);
    if (!zone) throw CleaningErrors.zoneNotFound();
    return zone;
  }

  private async view(id: string): Promise<ZoneView> {
    return (await this.views([await this.zone(id)]))[0] as ZoneView;
  }

  /** Demandes ouvertes (statut effectif, RV-14) et programmes en cours de chaque zone. */
  private async views(zones: Zone[]): Promise<ZoneView[]> {
    const activity = await this.deps.zones.activityOf(zones.map((zone) => zone.communeKey));
    const now = this.deps.clock.now();
    return zones.map((zone) => {
      const own = activity.get(zone.communeKey);
      return {
        ...zone,
        openRequests: own ? countOpenRequests(own.requests, now) : 0,
        activePrograms: own?.activePrograms ?? 0,
      };
    });
  }
}
