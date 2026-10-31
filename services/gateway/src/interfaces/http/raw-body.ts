import { type GatewayRequest, type GatewayResponse, type Next } from './http-types';

/** Taille maximum d'une notification de prestataire (64 Ko : un événement FedaPay en fait quelques-uns). */
export const WEBHOOK_MAX_BYTES = 64 * 1024;

type StreamingRequest = GatewayRequest & {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'error', listener: (error?: Error) => void): unknown;
  resume(): unknown;
  /** Marque du lecteur de corps d'Express : un corps déjà lu n'est plus analysé en JSON. */
  _body?: boolean;
};

/**
 * Corps brut des notifications de prestataire (x-ksp-raw-body, ADR-031) : la signature porte sur
 * les octets exacts, ils ne doivent pas passer par l'analyse JSON. Le corps est rangé tel quel
 * (Buffer) dans `request.body` ; au-delà de la limite : 413, comme pour les corps JSON.
 */
export function rawBody(limitBytes = WEBHOOK_MAX_BYTES) {
  return (request: GatewayRequest, _response: GatewayResponse, next: Next): void => {
    const stream = request as StreamingRequest;
    if (request.method !== 'POST') {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      next(error);
    };
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        finish({ status: 413, type: 'entity.too.large' });
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (done) return;
      request.body = Buffer.concat(chunks);
      stream._body = true;
      finish();
    });
    stream.on('error', (error) => finish(error));
  };
}
