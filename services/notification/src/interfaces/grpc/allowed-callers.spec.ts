import { allowedCallersOf } from '@ksp/platform';
import {
  InAppNotificationGrpcController,
  NotificationAdminGrpcController,
} from './notification-center.controller';
import { NotificationGrpcController } from './notification.controller';

/** Métadonnées utilisateur non signées : centre et back-office réservés à la gateway (ADR-050). */
describe('appelants des contrôleurs notification', () => {
  it.each([InAppNotificationGrpcController, NotificationAdminGrpcController])(
    '%p : gateway seule',
    (controller) => {
      expect(allowedCallersOf(controller)).toEqual(['gateway']);
    },
  );

  it('NotificationService (envoi direct) : services, contrôlés par le cas d’usage', () => {
    expect(allowedCallersOf(NotificationGrpcController)).toBeUndefined();
  });
});
