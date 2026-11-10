import { type ShutdownState } from '../health/shutdown';

export interface GracefulShutdownOptions {
  /**
   * Délai entre le signal SIGTERM et la fermeture (SHUTDOWN_DELAY_MS) : le temps que la réplique
   * soit retirée de la répartition (Traefik, clients gRPC) pendant qu'elle sert encore.
   */
  delayMs: number;
  /** Appelé dès le signal, en plus de la sonde « prêt » (par exemple la santé gRPC). */
  onDrain?: () => void;
  logger?: { log(message: string): void; error(message: string): void };
  /** Sortie du processus (remplacée dans les tests). */
  exit?: (code: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Arrêt en deux temps (ADR-051) : au signal, la réplique se déclare indisponible (sonde « prêt » en
 * 503, santé gRPC NOT_SERVING) mais continue de servir ; après le délai, elle ferme ses serveurs
 * (requêtes en cours terminées) et ses connexions, puis sort.
 * SIGINT (Ctrl+C en développement) ferme sans délai. Un second signal est ignoré.
 */
export function gracefulShutdown(
  app: { close(): Promise<void> },
  state: ShutdownState,
  options: GracefulShutdownOptions,
): (signal: NodeJS.Signals) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    state.begin();
    options.onDrain?.();
    const delayMs = signal === 'SIGTERM' ? options.delayMs : 0;
    options.logger?.log(`${signal} reçu : indisponible, fermeture dans ${delayMs} ms.`);
    await sleep(delayMs);
    try {
      await app.close();
      exit(0);
    } catch (error) {
      options.logger?.error(`Fermeture en échec : ${(error as Error).message}`);
      exit(1);
    }
  };
}

/** Branche l'arrêt en deux temps sur SIGTERM (k3s) et SIGINT ; remplace app.enableShutdownHooks(). */
export function enableGracefulShutdown(
  app: { close(): Promise<void> },
  state: ShutdownState,
  options: GracefulShutdownOptions,
): void {
  const shutdown = gracefulShutdown(app, state, options);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}
