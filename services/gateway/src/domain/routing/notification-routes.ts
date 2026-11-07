import { BACKOFFICE_MFA_SECONDS } from './cleaning-routes';
import { type RouteDefinition } from './route-manifest';

const CENTER = 'ksp.notification.v1.InAppNotificationService';
const ADMIN = 'ksp.notification.v1.NotificationAdminService';

/** Rôles du back-office des notifications (ADR-038) : direction et support client. */
const NOTIFICATION_STAFF = ['super_admin', 'support_agent'] as const;

const customer = { level: 'authenticated' } as const;
const staff = {
  level: 'authenticated',
  anyRole: NOTIFICATION_STAFF,
  recentMfaSeconds: BACKOFFICE_MFA_SECONDS,
} as const;

/**
 * Routes du centre de notifications (ADR-038) : espace KSP du client et back-office. Reprises des
 * extensions x-ksp-* du contrat OpenAPI ; le test de conformité vérifie qu'elles restent identiques.
 */
export const NOTIFICATION_ROUTES = [
  {
    operationId: 'listMyNotifications',
    method: 'GET',
    path: '/api/v1/notification/notifications',
    grpc: `${CENTER}/ListMyNotifications`,
    access: customer,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'countMyUnreadNotifications',
    method: 'GET',
    path: '/api/v1/notification/notifications/unread-count',
    grpc: `${CENTER}/CountMyUnreadNotifications`,
    access: customer,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'markNotificationRead',
    method: 'POST',
    path: '/api/v1/notification/notifications/{id}/read',
    grpc: `${CENTER}/MarkNotificationRead`,
    access: customer,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'markAllNotificationsRead',
    method: 'POST',
    path: '/api/v1/notification/notifications/read-all',
    grpc: `${CENTER}/MarkAllNotificationsRead`,
    access: customer,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getMyNotificationPreferences',
    method: 'GET',
    path: '/api/v1/notification/preferences',
    grpc: `${CENTER}/GetMyNotificationPreferences`,
    access: customer,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'updateMyNotificationPreferences',
    method: 'PUT',
    path: '/api/v1/notification/preferences',
    grpc: `${CENTER}/UpdateMyNotificationPreferences`,
    access: customer,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listNotificationDeliveries',
    method: 'GET',
    path: '/api/v1/admin/notification/deliveries',
    grpc: `${ADMIN}/ListDeliveries`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getNotificationDelivery',
    method: 'GET',
    path: '/api/v1/admin/notification/deliveries/{id}',
    grpc: `${ADMIN}/GetDelivery`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listNotificationTemplates',
    method: 'GET',
    path: '/api/v1/admin/notification/templates',
    grpc: `${ADMIN}/ListMessageTemplates`,
    access: staff,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
