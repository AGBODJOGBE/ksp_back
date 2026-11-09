import { INITIAL_BACKOFFICE_ROLES, type RoleDefinition } from './role';
import {
  accountTransition,
  canManageAccounts,
  canManageRole,
  parseAccountQuery,
  perimeterOf,
  seesFullPhone,
} from './role-administration';

const role = (code: string): RoleDefinition => INITIAL_BACKOFFICE_ROLES.find((r) => r.code === code)!;

describe("périmètre d'un administrateur", () => {
  it('super_admin : tout ; administrateur de métier : ses métiers ; les autres : rien', () => {
    expect(perimeterOf(['customer', 'super_admin'])).toEqual({ kind: 'all' });
    expect(perimeterOf(['cleaning_admin'])).toEqual({ kind: 'domains', services: ['cleaning'] });
    expect(perimeterOf(['cleaning_admin', 'recovery_admin'])).toEqual({
      kind: 'domains',
      services: ['cleaning', 'recovery'],
    });
    expect(perimeterOf(['cleaning_supervisor', 'support_agent'])).toBeNull();
  });

  it('super_admin gère tout rôle attribuable, y compris super_admin', () => {
    const all = { kind: 'all' } as const;
    for (const definition of INITIAL_BACKOFFICE_ROLES) expect(canManageRole(all, definition)).toBe(true);
    expect(canManageAccounts(all)).toBe(true);
    expect(seesFullPhone(all)).toBe(true);
  });

  it("l'administrateur du Nettoyage gère les rôles de son métier, sauf le sien", () => {
    const cleaning = perimeterOf(['cleaning_admin'])!;
    expect(canManageRole(cleaning, role('cleaning_agent'))).toBe(true);
    expect(canManageRole(cleaning, role('cleaning_supervisor'))).toBe(true);
    expect(canManageRole(cleaning, role('cleaning_admin'))).toBe(false);
    expect(canManageRole(cleaning, role('recovery_agent'))).toBe(false);
    expect(canManageRole(cleaning, role('super_admin'))).toBe(false);
    expect(canManageRole(cleaning, role('finance_officer'))).toBe(false);
    expect(canManageAccounts(cleaning)).toBe(false);
    expect(seesFullPhone(cleaning)).toBe(false);
  });

  it("un rôle d'organisation ou personnel ne s'attribue pas depuis le back-office", () => {
    const orgRole = { code: 'org_admin', service: 'identity', scopeType: 'org' } as const;
    const personal = { code: 'customer', service: 'identity', scopeType: 'personal' } as const;
    expect(canManageRole({ kind: 'all' }, orgRole)).toBe(false);
    expect(canManageRole({ kind: 'all' }, personal)).toBe(false);
  });
});

describe("état d'un compte", () => {
  it('actif → suspendu → actif ; aucune autre transition', () => {
    expect(accountTransition('active', 'suspend')).toBe('suspended');
    expect(accountTransition('suspended', 'reactivate')).toBe('active');
    expect(accountTransition('suspended', 'suspend')).toBeNull();
    expect(accountTransition('active', 'reactivate')).toBeNull();
    expect(accountTransition('deletion_pending', 'suspend')).toBeNull();
    expect(accountTransition('locked', 'reactivate')).toBeNull();
  });
});

describe('recherche de compte', () => {
  it('vide : équipe ; numéro complet : ce numéro ; sinon : mots du nom', () => {
    expect(parseAccountQuery('  ')).toEqual({ kind: 'staff' });
    expect(parseAccountQuery('+229 01 97 00 00 45')).toEqual({ kind: 'phone', e164: '+2290197000045' });
    expect(parseAccountQuery('  Awa   Dossou ')).toEqual({ kind: 'name', words: ['Awa', 'Dossou'] });
  });

  it('refuse un nom trop court ou une recherche trop longue ; retire les jokers', () => {
    expect(parseAccountQuery('a')).toBeNull();
    expect(parseAccountQuery('%_')).toBeNull();
    expect(parseAccountQuery('x'.repeat(101))).toBeNull();
    expect(parseAccountQuery('Aw%a')).toEqual({ kind: 'name', words: ['Awa'] });
  });
});
