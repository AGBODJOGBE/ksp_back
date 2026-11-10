import {
  Client,
  credentials,
  Metadata,
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import { grpcClientOptions, grpcServerOptions } from './grpc-options';

const PING = '/ksp.test.v1.TestService/Ping';
const raw = (value: Buffer) => value;

async function startServer(name: string, hits: string[]): Promise<{ port: number; stop: () => void }> {
  const server = new Server();
  server.addService(
    {
      ping: {
        path: PING,
        requestStream: false,
        responseStream: false,
        requestSerialize: raw,
        requestDeserialize: raw,
        responseSerialize: raw,
        responseDeserialize: raw,
      },
    },
    {
      ping: (_call: ServerUnaryCall<Buffer, Buffer>, callback: sendUnaryData<Buffer>) => {
        hits.push(name);
        callback(null, Buffer.from(name));
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  return { port, stop: () => server.forceShutdown() };
}

/** Options du client gRPC telles que NestJS les passe à grpc-js (canal + keepalive). */
function channelOptionsOf(url: string): Record<string, unknown> {
  const { options } = grpcClientOptions('TOKEN', 'identity', url) as {
    options: { channelOptions?: Record<string, unknown>; keepalive?: Record<string, number> };
  };
  const { interceptors: _interceptors, ...channel } = options.channelOptions ?? {};
  return {
    ...channel,
    'grpc.keepalive_time_ms': options.keepalive?.keepaliveTimeMs,
    'grpc.keepalive_timeout_ms': options.keepalive?.keepaliveTimeoutMs,
    'grpc.keepalive_permit_without_calls': options.keepalive?.keepalivePermitWithoutCalls,
  };
}

describe('répartition des appels gRPC entre répliques (ADR-051)', () => {
  it('les appels sont répartis entre toutes les adresses du service (round_robin)', async () => {
    const hits: string[] = [];
    const a = await startServer('a', hits);
    const b = await startServer('b', hits);
    // Plusieurs adresses, comme le DNS d'un service headless (dns:///identity-headless:50051).
    const url = `ipv4:127.0.0.1:${a.port},127.0.0.1:${b.port}`;
    const client = new Client(url, credentials.createInsecure(), channelOptionsOf(url));
    try {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve, reject) =>
          client.makeUnaryRequest(PING, raw, raw, Buffer.from('ping'), new Metadata(), (error, value) =>
            error ? reject(error) : resolve(value),
          ),
        );
      }
      expect(new Set(hits)).toEqual(new Set(['a', 'b']));
    } finally {
      client.close();
      a.stop();
      b.stop();
    }
  });

  it('les connexions sont vérifiées par keepalive et renouvelées côté serveur', () => {
    const client = grpcClientOptions('TOKEN', 'identity', 'dns:///identity:50051') as {
      options: { keepalive?: Record<string, number> };
    };
    expect(client.options.keepalive).toMatchObject({ keepalivePermitWithoutCalls: 1 });
    expect(client.options.keepalive?.keepaliveTimeMs).toBeGreaterThan(0);

    const server = grpcServerOptions(['identity'], 50051).options;
    // Âge maximum : les clients se reconnectent et découvrent les nouvelles répliques.
    expect(server.channelOptions?.['grpc.max_connection_age_ms']).toBeGreaterThan(0);
    // Arrêt : les appels en cours se terminent au lieu d'être coupés.
    expect(server.gracefulShutdown).toBe(true);
  });
});
