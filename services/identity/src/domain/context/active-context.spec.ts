import { activeContextOf, PERSONAL_CONTEXT } from './active-context';

describe('activeContextOf', () => {
  it('le contexte personnel est celui d’un particulier', () => {
    expect(activeContextOf(PERSONAL_CONTEXT)).toEqual({
      type: 'individual',
      organizationId: null,
      organizationName: null,
    });
  });

  it('un contexte absent est traité comme personnel, comme dans cleaning et billing', () => {
    expect(activeContextOf('', 'ignorée')).toEqual({
      type: 'individual',
      organizationId: null,
      organizationName: null,
    });
  });

  it('une organisation active est celle d’une entreprise', () => {
    const organizationId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e20';
    expect(activeContextOf(organizationId)).toEqual({
      type: 'business',
      organizationId,
      organizationName: null,
    });
    expect(activeContextOf(organizationId, 'SARL Bénin Propre')).toEqual({
      type: 'business',
      organizationId,
      organizationName: 'SARL Bénin Propre',
    });
  });
});
