import { AppError } from '@ksp/platform';
import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { toHttpError } from './error-response';

describe('toHttpError (UC-GW-06)', () => {
  it.each([
    [AppError.invalid('IDENTITY_OTP_INVALID', 'x'), 400],
    [AppError.unauthenticated('GATEWAY_TOKEN_EXPIRED', 'x'), 401],
    [AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'x'), 403],
    [AppError.notFound('IDENTITY_USER_NOT_FOUND', 'x'), 404],
    [AppError.conflict('IDENTITY_PHONE_TAKEN', 'x'), 409],
    [AppError.precondition('IDENTITY_OTP_EXPIRED', 'x'), 422],
    [AppError.rateLimited('GATEWAY_RATE_LIMITED', 'x'), 429],
    [AppError.notImplemented('IDENTITY_NOT_READY'), 501],
    [AppError.unavailable('IDENTITY_UNAVAILABLE', 'x'), 503],
    [new AppError('DEADLINE_EXCEEDED', 'IDENTITY_TIMEOUT', 'x'), 504],
  ])('%s → %i', (error, status) => {
    expect(toHttpError(error)).toEqual({
      status,
      code: error.code,
      message: error.message,
      details: error.details,
    });
  });

  it('erreur interne : code gardé, message masqué', () => {
    const error = new AppError(
      'INTERNAL',
      'GATEWAY_UPSTREAM_ERROR',
      "Réponse d'identity inattendue (statut 9).",
    );
    expect(toHttpError(error)).toEqual({
      status: 500,
      code: 'GATEWAY_UPSTREAM_ERROR',
      message: 'Une erreur interne est survenue. Réessayez plus tard.',
      details: {},
    });
  });

  it('erreur inattendue : 500 générique, sans trace ni adresse', () => {
    const error = toHttpError(new Error('connect ECONNREFUSED 10.0.3.12:50051'));
    expect(error).toMatchObject({ status: 500, code: 'GATEWAY_INTERNAL_ERROR' });
    expect(JSON.stringify(error)).not.toContain('10.0.3.12');
  });

  it('route inconnue, corps trop gros ou illisible', () => {
    expect(toHttpError(new NotFoundException())).toMatchObject({
      status: 404,
      code: 'GATEWAY_ROUTE_NOT_FOUND',
    });
    expect(toHttpError(new PayloadTooLargeException())).toMatchObject({
      status: 413,
      code: 'GATEWAY_PAYLOAD_TOO_LARGE',
    });
    expect(toHttpError({ status: 413, type: 'entity.too.large' })).toMatchObject({ status: 413 });
    expect(toHttpError({ status: 415, type: 'charset.unsupported' })).toMatchObject({
      status: 400,
      code: 'GATEWAY_VALIDATION_FAILED',
    });
  });
});
