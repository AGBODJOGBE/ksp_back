import { z } from 'zod';

/**
 * Corps et paramètres des routes du centre de notifications (ADR-039), repris du contrat OpenAPI :
 * tout champ inconnu est refusé. Les règles (canaux facultatifs, dates) restent dans notification.
 */
export const notificationBodies = {
  updateMyNotificationPreferences: z.strictObject({ whatsapp: z.boolean(), email: z.boolean() }),
};

export const notificationParams = {
  unread: z.enum(['true', 'false']).optional(),
  channel: z.enum(['sms', 'whatsapp', 'email', 'push', 'in_app']).optional(),
  status: z.enum(['pending', 'accepted', 'failed']).optional(),
  templateCode: z
    .string()
    .regex(/^[a-z][a-z0-9_.]{0,99}$/)
    .optional(),
  optionalId: z.guid().optional(),
  /** Date AAAA-MM-JJ (jour civil au Bénin) ; notification vérifie qu'elle existe. */
  optionalDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
};
