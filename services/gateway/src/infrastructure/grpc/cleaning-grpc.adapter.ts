import { type Metadata } from '@grpc/grpc-js';
import { type AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type CleaningApi, type CleaningCall } from '../../application/cleaning/cleaning.ports';
import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';
import { CLEANING_BINDINGS, CLEANING_MESSAGES } from './cleaning-bindings';
import { type CleaningBinding, CleaningCodec } from './cleaning-codec';
import { toUpstreamError } from './upstream-error';

/** Méthode d'un client gRPC généré : message, métadonnées → réponse. */
type GrpcMethod = (request: unknown, metadata: Metadata) => Observable<unknown>;

/** Clients des services de ksp.cleaning.v1, par nom de service (ClientGrpc.getService). */
export type CleaningClients = (service: string) => Record<string, GrpcMethod | undefined>;

/**
 * Client gRPC de cleaning, commun à toutes les routes du Nettoyage : chaque route a son appel et sa
 * conversion dans cleaning-bindings.ts, produit depuis les contrats. Délai, coupe-circuit et jeton
 * de service par GrpcCaller. Seules les lectures sont rejouées ; une écriture ne l'est jamais
 * (cahier des charges Gateway, partie 4). Aucun journal du contenu : les dossiers portent des
 * positions, des adresses et des liens de pièces d'identité.
 */
export class CleaningGrpcAdapter implements CleaningApi {
  private readonly logger = new Logger('CleaningGrpc');
  private readonly codec = new CleaningCodec(CLEANING_MESSAGES);
  private readonly services = new Map<string, Record<string, GrpcMethod | undefined>>();

  constructor(
    private readonly clients: CleaningClients,
    private readonly caller: GrpcCaller,
  ) {}

  async call(operationId: CleaningOperationId, call: CleaningCall): Promise<unknown> {
    const binding: CleaningBinding = CLEANING_BINDINGS[operationId];
    const client = this.client(binding.service);
    const invoke = client[binding.method];
    if (!invoke) throw new Error(`Méthode ${binding.service}.${binding.method} absente du client cleaning`);
    const message = this.codec.request(binding, call);
    const name = `${binding.service}.${binding.method}`;
    try {
      const response = await this.caller.call(name, (metadata) => invoke.call(client, message, metadata), {
        idempotent: call.read,
      });
      return this.codec.response(binding, response);
    } catch (error) {
      const upstream = toUpstreamError('cleaning', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`cleaning.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }

  private client(service: string): Record<string, GrpcMethod | undefined> {
    let client = this.services.get(service);
    if (!client) {
      client = this.clients(service);
      this.services.set(service, client);
    }
    return client;
  }
}
