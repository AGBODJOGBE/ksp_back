import { Injectable } from '@nestjs/common';

/**
 * Arrêt en cours (ADR-051) : dès le signal d'arrêt, la sonde « prêt » répond 503 pour que la
 * réplique soit retirée de la répartition, alors qu'elle sert encore les requêtes qui arrivent.
 */
@Injectable()
export class ShutdownState {
  private stopping = false;

  get draining(): boolean {
    return this.stopping;
  }

  begin(): void {
    this.stopping = true;
  }
}
