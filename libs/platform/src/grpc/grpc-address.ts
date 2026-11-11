import { type z } from 'zod';

/** Hôte localhost (valeur par défaut des adresses gRPC), avec ou sans schéma (dns:///) ni port. */
const LOCALHOST = /^(?:dns:(?:\/\/\/?)?)?localhost(?::\d+)?$/i;

/**
 * Contrôle de configuration (à passer à superRefine) : en production, chaque adresse gRPC d'un
 * service appelé (variable *_GRPC_URL) doit être fournie : la valeur par défaut localhost:<port>,
 * commode en développement, ferait échouer chaque appel en production (ADR-051). Une adresse IP
 * explicite reste permise (services simulés des tests).
 */
export function requireGrpcAddressesInProduction(cfg: { NODE_ENV: string }, ctx: z.RefinementCtx): void {
  if (cfg.NODE_ENV !== 'production') return;
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.endsWith('_GRPC_URL') || typeof value !== 'string') continue;
    if (LOCALHOST.test(value.trim())) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message:
          'Obligatoire en production, jamais localhost : adresse du service headless (dns:///<service>-headless:<port>).',
      });
    }
  }
}
