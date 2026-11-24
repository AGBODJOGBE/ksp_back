import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLEANING_PERMISSION_CATALOG as CATALOG,
  PERMISSIONS_WITHOUT_ROUTE,
  type CatalogRole,
} from './permission-catalog';

/**
 * Catalogue des permissions du Nettoyage (R-RB-01) : liste fermée, comparée aux routes de la gateway
 * et au contrat OpenAPI, qui font foi. Les deux fichiers sont lus comme du texte : cleaning ne dépend
 * pas du code de la gateway.
 */
const REPOSITORY = join(__dirname, '..', '..', '..', '..', '..');
const GATEWAY_ROUTES = join(REPOSITORY, 'services/gateway/src/domain/routing/cleaning-routes.ts');
const OPENAPI = join(REPOSITORY, 'contracts/openapi/ksp-api.v1.yaml');
const SOURCES = join(__dirname, '..', '..');

const codes = CATALOG.permissions.map((permission) => permission.code);
const role = (code: string): CatalogRole => {
  const found = CATALOG.roles.find((candidate) => candidate.code === code);
  if (!found) throw new Error(`Rôle ${code} absent du catalogue.`);
  return found;
};

/** Permissions exigées par les routes du Nettoyage à la gateway (extension x-ksp-permission). */
function routePermissions(): string[] {
  const source = readFileSync(GATEWAY_ROUTES, 'utf8');
  return [...new Set([...source.matchAll(/permission: '([a-z0-9_.]+)'/g)].map(([, code]) => code!))].sort();
}

/** Rôles par défaut de chaque permission dans le contrat (x-ksp-default-roles), sans super_admin. */
function contractDefaultRoles(): Map<string, string[]> {
  const source = readFileSync(OPENAPI, 'utf8');
  const blocks = source.matchAll(/x-ksp-permission: (\S+)\r?\n\s+x-ksp-default-roles:((?:\r?\n\s+- \S+)+)/g);
  const result = new Map<string, string[]>();
  for (const [, permission, list] of blocks) {
    const roles = [...list!.matchAll(/- (\S+)/g)]
      .map(([, code]) => code!)
      .filter((code) => code !== 'super_admin')
      .sort();
    const known = result.get(permission!);
    if (known && known.join() !== roles.join()) {
      throw new Error(`Rôles par défaut différents d'une route à l'autre pour ${permission}.`);
    }
    result.set(permission!, roles);
  }
  return result;
}

/** Fichiers de code du service, hors tests. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('catalogue des permissions du Nettoyage (R-RB-01)', () => {
  it('les 16 permissions du cahier des charges (partie 2), chacune avec son libellé', () => {
    expect(CATALOG.service).toBe('cleaning');
    expect(codes).toHaveLength(16);
    expect(new Set(codes).size).toBe(codes.length);
    for (const permission of CATALOG.permissions) {
      expect(permission.code).toMatch(/^cleaning\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(permission.description.trim().length).toBeGreaterThan(10);
    }
  });

  it('toute permission exigée par une route de la gateway est déclarée', () => {
    const required = routePermissions();
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((code) => !codes.includes(code))).toEqual([]);
  });

  it('aucune permission déclarée sans route, sauf celle qui filtre les montants des réponses', () => {
    const required = routePermissions();
    const withoutRoute = codes.filter((code) => !required.includes(code));
    // cleaning.amounts.read n'ouvre aucune route : elle décide si les montants figurent dans les
    // réponses du back-office (R-EX-04, 16.3), contrôle fait par le service (seesAmounts).
    expect(withoutRoute).toEqual(['cleaning.amounts.read']);
    expect(Object.keys(PERMISSIONS_WITHOUT_ROUTE)).toEqual(withoutRoute);
  });

  it('toute permission contrôlée dans le code du service est déclarée', () => {
    const actions = new Set(codes.map((code) => code.split('.')[2]));
    const checked = new Set<string>();
    for (const file of sourceFiles(SOURCES)) {
      for (const [, code] of readFileSync(file, 'utf8').matchAll(/'(cleaning\.[a-z_]+\.[a-z_]+)'/g)) {
        // Les types d'événement ont la même forme : seules les actions du catalogue sont des permissions.
        if (actions.has(code!.split('.')[2])) checked.add(code!);
      }
    }
    expect(checked.size).toBeGreaterThan(5);
    expect([...checked].filter((code) => !codes.includes(code))).toEqual([]);
  });
});

describe('rôles livrés par défaut (partie 2)', () => {
  it('les cinq rôles du cahier des charges, qui ne cochent que des permissions du catalogue', () => {
    expect(CATALOG.roles.map((candidate) => candidate.code)).toEqual([
      'cleaning_admin',
      'cleaning_supervisor',
      'cleaning_agent',
      'finance_officer',
      'support_agent',
    ]);
    for (const candidate of CATALOG.roles) {
      expect(candidate.permissions.filter((code) => !codes.includes(code))).toEqual([]);
      expect(new Set(candidate.permissions).size).toBe(candidate.permissions.length);
      expect(candidate.name.trim()).not.toBe('');
      // Règles d'identity : portée globale ou métier, double authentification pour le back-office.
      expect(['global', 'domain']).toContain(candidate.scopeType);
      if (candidate.backofficeAccess) expect(candidate.requiresMfa).toBe(true);
    }
  });

  it('les permissions de terrain ne vont qu’à l’agent, qui n’a rien d’autre (R-AG-01, RV-07)', () => {
    expect([...role('cleaning_agent').permissions].sort()).toEqual([
      'cleaning.session.perform',
      'cleaning.visit.perform',
    ]);
    expect(role('cleaning_agent')).toMatchObject({ backofficeAccess: false, requiresMfa: false });
    for (const candidate of CATALOG.roles.filter((other) => other.code !== 'cleaning_agent')) {
      expect(candidate.permissions).not.toContain('cleaning.session.perform');
      expect(candidate.permissions).not.toContain('cleaning.visit.perform');
    }
  });

  it('l’admin Nettoyage a tout le module hors terrain ; la finance voit les montants (rôle sensible)', () => {
    const field = ['cleaning.session.perform', 'cleaning.visit.perform'];
    expect([...role('cleaning_admin').permissions].sort()).toEqual(
      codes.filter((code) => !field.includes(code)).sort(),
    );
    expect(role('finance_officer')).toMatchObject({
      permissions: ['cleaning.amounts.read'],
      sensitive: true,
    });
  });

  it('chaque permission d’une route va aux rôles par défaut écrits dans le contrat', () => {
    const contract = contractDefaultRoles();
    expect([...contract.keys()].sort()).toEqual(routePermissions());
    for (const [permission, roles] of contract) {
      const holders = CATALOG.roles
        .filter((candidate) => candidate.permissions.includes(permission))
        .map((candidate) => candidate.code)
        .sort();
      expect({ permission, roles: holders }).toEqual({ permission, roles });
    }
  });
});

describe('version du catalogue', () => {
  it('toute modification du catalogue change sa version : identity ignore une version déjà enregistrée', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ permissions: CATALOG.permissions, roles: CATALOG.roles }))
      .digest('hex')
      .slice(0, 16);
    // Après une modification du catalogue : augmenter `version`, puis reporter ici la nouvelle empreinte.
    expect({ version: CATALOG.version, fingerprint }).toEqual({
      version: 1,
      fingerprint: 'ffeb0f92dd5025b4',
    });
  });
});
