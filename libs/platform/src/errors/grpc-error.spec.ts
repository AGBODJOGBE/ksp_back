import { status as GrpcStatus } from '@grpc/grpc-js';
import { AppError } from './app-error';
import { fromGrpcError, HTTP_STATUS_BY_GRPC, toGrpcErrorPayload } from './grpc-error';

describe('erreurs gRPC', () => {
  it('traduit une AppError en statut gRPC avec son code applicatif', () => {
    const payload = toGrpcErrorPayload(AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'));
    expect(payload.code).toBe(GrpcStatus.NOT_FOUND);
    expect(JSON.parse(payload.details)).toEqual({
      code: 'IDENTITY_USER_NOT_FOUND',
      message: 'Compte introuvable.',
      details: {},
    });
  });

  it('masque toute erreur inattendue', () => {
    const payload = toGrpcErrorPayload(new Error('connect ECONNREFUSED 10.0.3.12:5432'));
    expect(payload.code).toBe(GrpcStatus.INTERNAL);
    expect(payload.details).not.toContain('10.0.3.12');
    expect(JSON.parse(payload.details).code).toBe('INTERNAL_ERROR');
  });

  it('reconstruit l’AppError côté appelant (aller-retour)', () => {
    const original = AppError.conflict('IDENTITY_PHONE_TAKEN', 'Ce numéro est déjà utilisé.', {
      field: 'phone',
    });
    const sent = toGrpcErrorPayload(original);
    const received = fromGrpcError({ code: sent.code, details: sent.details });
    expect(received).toMatchObject({
      kind: 'CONFLICT',
      code: 'IDENTITY_PHONE_TAKEN',
      details: { field: 'phone' },
    });
  });

  it('donne un code générique à une erreur réseau qui ne vient pas de nos services', () => {
    const received = fromGrpcError({ code: GrpcStatus.UNAVAILABLE, details: 'No connection established' });
    expect(received.kind).toBe('UNAVAILABLE');
    expect(received.code).toBe('GRPC_UNAVAILABLE');
  });

  it('respecte la table de traduction vers HTTP du cahier des charges', () => {
    expect(HTTP_STATUS_BY_GRPC[GrpcStatus.FAILED_PRECONDITION]).toBe(422);
    expect(HTTP_STATUS_BY_GRPC[GrpcStatus.RESOURCE_EXHAUSTED]).toBe(429);
    expect(HTTP_STATUS_BY_GRPC[GrpcStatus.DEADLINE_EXCEEDED]).toBe(504);
  });
});
