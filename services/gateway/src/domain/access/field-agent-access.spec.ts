import { CLEANING_ROUTES } from '../routing/cleaning-routes';
import { type RouteDefinition } from '../routing/route-manifest';
import { type Caller, checkAccess } from './access-policy';

/**
 * Agent de terrain du Nettoyage (R-RB-07) : sa session de l'application agent porte dans son jeton
 * les permissions du rôle cleaning_agent (perms), sans double authentification. Elle ouvre les
 * routes de terrain, et aucune route du back-office.
 */
const NOW = 1_800_000_000;
const FIELD_PERMISSIONS = ['cleaning.visit.perform', 'cleaning.session.perform'];
const ROUTES: readonly RouteDefinition[] = CLEANING_ROUTES;

const agent: Caller = {
  roles: [{ role: 'customer' }],
  mfa: false,
  authTime: NOW - 60,
  permissions: { global: FIELD_PERMISSIONS, byZone: {} },
};
const decision = (route: RouteDefinition, caller: Caller) => checkAccess(route.access, caller, NOW);
const isBackOffice = (route: RouteDefinition) => route.path.startsWith('/api/v1/admin/');

describe('accès d’un agent de terrain aux routes du Nettoyage', () => {
  const fieldRoutes = ROUTES.filter((route) => FIELD_PERMISSIONS.includes(route.access.permission ?? ''));

  it('passe toutes les routes de terrain : visites et séances', () => {
    expect(fieldRoutes).toHaveLength(24);
    expect(fieldRoutes.filter(isBackOffice)).toEqual([]);
    for (const route of fieldRoutes) {
      expect({ route: route.operationId, ...decision(route, agent) }).toEqual({
        route: route.operationId,
        allowed: true,
      });
    }
  });

  it('ne passe aucune route du back-office, ni aucune route d’une autre permission', () => {
    const backOffice = ROUTES.filter(isBackOffice);
    expect(backOffice.length).toBeGreaterThan(100);
    for (const route of backOffice) {
      expect({ route: route.operationId, ...decision(route, agent) }).toEqual({
        route: route.operationId,
        allowed: false,
        reason: 'permission_missing',
      });
    }
    const others = ROUTES.filter(
      (route) => route.access.permission && !FIELD_PERMISSIONS.includes(route.access.permission),
    );
    expect(others.every((route) => !decision(route, agent).allowed)).toBe(true);
  });

  it('sans ces permissions dans le jeton (client, agent pas encore validé), les routes de terrain sont refusées', () => {
    const customer: Caller = { roles: [{ role: 'customer' }], mfa: false, authTime: NOW - 60 };
    const noPermission: Caller = { ...customer, permissions: { global: [], byZone: {} } };
    for (const caller of [customer, noPermission]) {
      for (const route of fieldRoutes) {
        expect(decision(route, caller)).toEqual({ allowed: false, reason: 'permission_missing' });
      }
    }
  });

  it('permission limitée à une commune : la gateway laisse passer, le service vérifie le dossier', () => {
    const zoned: Caller = {
      ...agent,
      permissions: { global: [], byZone: { cotonou: ['cleaning.session.perform'] } },
    };
    const sessions = fieldRoutes.filter((route) => route.access.permission === 'cleaning.session.perform');
    expect(sessions.every((route) => decision(route, zoned).allowed)).toBe(true);
  });
});
