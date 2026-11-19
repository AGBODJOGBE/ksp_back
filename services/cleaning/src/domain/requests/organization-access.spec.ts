/**
 * Droits dans l'organisation sur un dossier (R-CP-03, R-AC-02, RV-11).
 *
 * Matrice règle → test :
 * - R-CP-03 lecteur : consultation seulement                 → « lecteur »
 * - R-CP-03 membre : demande, frais, créneau, annulation,
 *   réactivation, transmission du devis                     → « membre »
 * - R-AC-02 seul l'administrateur accepte ou refuse un devis → « administrateur »
 * - R-CP-04 contexte personnel : le titulaire fait tout      → « contexte personnel »
 * - RV-11 refus : AUTH_FORBIDDEN, details.organizationRole   → « membre », « lecteur »
 */
import { DomainRuleError } from './errors';
import {
  assertOrganizationRight,
  CLIENT_CASE_ACTIONS,
  type ClientCaseAction,
  hasOrganizationRight,
} from './organization-access';

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

const MEMBER_ACTIONS: ClientCaseAction[] = [
  'view',
  'submit_request',
  'pay_visit_fee',
  'change_visit_slot',
  'cancel_request',
  'request_reactivation',
  'forward_quote',
];
const ADMIN_ONLY: ClientCaseAction[] = ['accept_quote', 'decline_quote'];

describe('lecteur', () => {
  it('consulte le dossier', () => {
    expect(hasOrganizationRight('org_viewer', 'view')).toBe(true);
  });

  it.each(CLIENT_CASE_ACTIONS.filter((action) => action !== 'view'))('ne peut pas : %s', (action) => {
    const error = thrown(() => assertOrganizationRight('org_viewer', action));
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(error.details).toEqual({ organizationRole: 'org_viewer' });
  });
});

describe('membre', () => {
  it.each(MEMBER_ACTIONS)('peut : %s', (action) => {
    expect(() => assertOrganizationRight('org_member', action)).not.toThrow();
  });

  it.each(ADMIN_ONLY)('ne peut pas : %s (il transmet le devis pour accord)', (action) => {
    const error = thrown(() => assertOrganizationRight('org_member', action));
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(error.details).toEqual({ organizationRole: 'org_member' });
  });
});

describe('administrateur', () => {
  it.each(CLIENT_CASE_ACTIONS)('peut : %s', (action) => {
    expect(hasOrganizationRight('org_admin', action)).toBe(true);
  });
});

describe('contexte personnel', () => {
  it.each(CLIENT_CASE_ACTIONS)('le titulaire peut : %s', (action) => {
    expect(() => assertOrganizationRight(null, action)).not.toThrow();
  });
});
