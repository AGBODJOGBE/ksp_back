import {
  Client,
  credentials,
  Metadata,
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { currentDeadline, deadlineInterceptor, runWithDeadline } from './deadline';
import { GrpcCaller } from './grpc-caller';
import { GrpcContextInterceptor } from './grpc-context.interceptor';
import { grpcClientOptions } from './grpc-options';

const PING = '/ksp.test.v1.TestService/Ping';
const raw = (value: Buffer) => value;

/** Serveur gRPC réel : chaque appel note l'échéance reçue sur le fil (en-tête grpc-timeout). */
async function startServer(): Promise<{ address: string; deadlines: number[]; stop: () => void }> {
  const deadlines: number[] = [];
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
      ping: (call: ServerUnaryCall<Buffer, Buffer>, callback: sendUnaryData<Buffer>) => {
        deadlines.push(Number(call.getDeadline()));
        callback(null, Buffer.from('pong'));
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  return { address: `127.0.0.1:${port}`, deadlines, stop: () => server.forceShutdown() };
}

describe('échéance des appels gRPC (ADR-051)', () => {
  it('l’échéance de l’appel est transmise au service appelé', async () => {
    const server = await startServer();
    // Même intercepteur que les clients déclarés par grpcClientOptions.
    const client = new Client(server.address, credentials.createInsecure(), {
      interceptors: [deadlineInterceptor],
    });
    try {
      const caller = new GrpcCaller({ target: 'test', defaultDeadlineMs: 2000 });
      const before = Date.now();
      await caller.call(
        'Ping',
        (metadata) =>
          new Promise<Buffer>((resolve, reject) =>
            client.makeUnaryRequest(PING, raw, raw, Buffer.from('ping'), metadata, (error, value) =>
              error ? reject(error) : resolve(value as Buffer),
            ),
          ),
      );
      expect(server.deadlines).toHaveLength(1);
      const received = server.deadlines[0]!;
      expect(Number.isFinite(received)).toBe(true);
      expect(received).toBeGreaterThan(before + 1500);
      expect(received).toBeLessThanOrEqual(Date.now() + 2000);
    } finally {
      client.close();
      server.stop();
    }
  });

  it('les clients déclarés par grpcClientOptions portent l’intercepteur d’échéance', () => {
    const options = grpcClientOptions('TOKEN', 'identity', 'dns:///identity:50051') as {
      options: { channelOptions?: { interceptors?: unknown[] } };
    };
    expect(options.options.channelOptions?.interceptors).toContain(deadlineInterceptor);
  });

  it('un appel sortant ne dépasse jamais l’échéance de l’appel reçu', async () => {
    const caller = new GrpcCaller({ target: 'wallet', defaultDeadlineMs: 3000 });
    const inherited = new Date(Date.now() + 500);
    let seen: Date | undefined;
    await runWithDeadline(inherited, () =>
      caller.call('GetBalance', () => {
        seen = currentDeadline();
        return of('ok');
      }),
    );
    expect(seen).toEqual(inherited);
  });

  it('échéance reçue déjà dépassée : échec immédiat, sans appel ni coupe-circuit', async () => {
    const caller = new GrpcCaller({ target: 'wallet', breaker: { volumeThreshold: 1 } });
    let invoked = false;
    for (let i = 0; i < 3; i += 1) {
      await expect(
        runWithDeadline(new Date(Date.now() - 1), () =>
          caller.call('GetBalance', () => {
            invoked = true;
            return of('ok');
          }),
        ),
      ).rejects.toMatchObject({ kind: 'DEADLINE_EXCEEDED' });
    }
    expect(invoked).toBe(false);
    expect(caller.isOpen).toBe(false);
  });

  it('un appel reçu s’exécute avec son échéance : les appels sortants la propagent', async () => {
    const deadline = new Date(Date.now() + 1234);
    const call = { getDeadline: () => deadline };
    const context = {
      getType: () => 'rpc',
      switchToRpc: () => ({ getContext: () => new Metadata() }),
      getArgByIndex: (index: number) => (index === 2 ? call : undefined),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(currentDeadline()) };
    const seen = await firstValueFrom(new GrpcContextInterceptor().intercept(context, next));
    expect(seen).toEqual(deadline);
  });

  it('sans échéance reçue (Infinity), seule l’échéance par défaut de l’appelant s’applique', async () => {
    const call = { getDeadline: () => Infinity };
    const context = {
      getType: () => 'rpc',
      switchToRpc: () => ({ getContext: () => new Metadata() }),
      getArgByIndex: (index: number) => (index === 2 ? call : undefined),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(currentDeadline()) };
    await expect(firstValueFrom(new GrpcContextInterceptor().intercept(context, next))).resolves.toBe(
      undefined,
    );
  });
});
