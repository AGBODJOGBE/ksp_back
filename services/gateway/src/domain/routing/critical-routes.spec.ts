import { CRITICAL_MFA_SECONDS } from './cleaning-routes';
import { findRoute } from './route-manifest';

/**
 * Actions critiques du back-office (ADR-050) : double authentification de moins de 10 minutes, et
 * non celle de l'ouverture de la session (12 heures).
 */
const CRITICAL = [
  'grantAccountRole',
  'revokeAccountRole',
  'suspendAccount',
  'reactivateAccount',
  'resetAccountMfa',
  'creditPrepaidWallet',
  'approveManualCredit',
  'confirmPayout',
  'failPayout',
  'resolvePaymentMismatch',
];

describe('actions critiques du back-office', () => {
  it('fixe la double authentification récente à 10 minutes', () => {
    expect(CRITICAL_MFA_SECONDS).toBe(600);
  });

  it.each(CRITICAL)('%s exige une double authentification de moins de 10 minutes', (operationId) => {
    expect(findRoute(operationId)?.access).toMatchObject({
      level: 'authenticated',
      recentMfaSeconds: CRITICAL_MFA_SECONDS,
    });
  });
});
