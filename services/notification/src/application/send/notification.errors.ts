import { AppError } from '@ksp/platform';
import { type ChannelName } from '../../domain/channel';

/** Erreurs de SendNotification (codes du contrat notification.proto, messages en français). */
export const NotificationErrors = {
  templateUnknown: () =>
    AppError.notFound('NOTIFICATION_TEMPLATE_UNKNOWN', "Ce modèle de message n'existe pas pour ce canal."),

  recipientInvalid: () =>
    AppError.invalid(
      'NOTIFICATION_RECIPIENT_INVALID',
      'Le destinataire est absent ou ne peut pas recevoir de message par ce canal.',
    ),

  channelsExhausted: (channelsTried: ChannelName[]) =>
    AppError.unavailable(
      'NOTIFICATION_CHANNELS_EXHAUSTED',
      "Le message n'a pu être envoyé par aucun canal. Réessayez dans quelques instants.",
      { channelsTried },
    ),

  /** Les variables obligatoires du modèle manquent ou sont mal formées (noms seuls). */
  variablesInvalid: (names: string[]) =>
    AppError.invalid(
      'NOTIFICATION_VARIABLES_INVALID',
      'Les variables du modèle sont incomplètes ou mal formées.',
      { invalidVariables: names },
    ),

  /** Le jeton de service désigne un service non autorisé à cet appel. */
  callerForbidden: () =>
    AppError.forbidden(
      'NOTIFICATION_CALLER_FORBIDDEN',
      "Ce service n'est pas autorisé à envoyer des notifications directes.",
    ),

  /** Un envoi avec la même clé d'idempotence est en cours (ou a été interrompu). */
  alreadyInProgress: () =>
    AppError.conflict(
      'NOTIFICATION_ALREADY_IN_PROGRESS',
      'Un envoi avec cette clé est déjà en cours. Utilisez une nouvelle clé pour un nouvel envoi.',
    ),
};
