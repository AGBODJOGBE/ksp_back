import { status as GrpcStatus } from '@grpc/grpc-js';
import { AppError, type ErrorDetails, type ErrorKind } from './app-error';

const KIND_TO_STATUS: Record<ErrorKind, GrpcStatus> = {
  INVALID_ARGUMENT: GrpcStatus.INVALID_ARGUMENT,
  UNAUTHENTICATED: GrpcStatus.UNAUTHENTICATED,
  PERMISSION_DENIED: GrpcStatus.PERMISSION_DENIED,
  NOT_FOUND: GrpcStatus.NOT_FOUND,
  CONFLICT: GrpcStatus.ALREADY_EXISTS,
  FAILED_PRECONDITION: GrpcStatus.FAILED_PRECONDITION,
  RESOURCE_EXHAUSTED: GrpcStatus.RESOURCE_EXHAUSTED,
  UNAVAILABLE: GrpcStatus.UNAVAILABLE,
  DEADLINE_EXCEEDED: GrpcStatus.DEADLINE_EXCEEDED,
  NOT_IMPLEMENTED: GrpcStatus.UNIMPLEMENTED,
  INTERNAL: GrpcStatus.INTERNAL,
};

const STATUS_TO_KIND = new Map<GrpcStatus, ErrorKind>([
  ...Object.entries(KIND_TO_STATUS).map(([kind, code]) => [code, kind as ErrorKind] as const),
  [GrpcStatus.ABORTED, 'CONFLICT'],
  [GrpcStatus.UNKNOWN, 'INTERNAL'],
  [GrpcStatus.CANCELLED, 'UNAVAILABLE'],
]);

/** Table de traduction gRPC → HTTP utilisée par la gateway (cahier des charges Gateway, partie 6). */
export const HTTP_STATUS_BY_GRPC: Readonly<Record<number, number>> = {
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.ABORTED]: 409,
  [GrpcStatus.FAILED_PRECONDITION]: 422,
  [GrpcStatus.RESOURCE_EXHAUSTED]: 429,
  [GrpcStatus.UNIMPLEMENTED]: 501,
  [GrpcStatus.INTERNAL]: 500,
  [GrpcStatus.UNKNOWN]: 500,
  [GrpcStatus.UNAVAILABLE]: 503,
  [GrpcStatus.CANCELLED]: 503,
  [GrpcStatus.DEADLINE_EXCEEDED]: 504,
};

export function grpcStatusOf(kind: ErrorKind): GrpcStatus {
  return KIND_TO_STATUS[kind];
}

/** Erreur telle que transmise sur le réseau gRPC : le statut, et le détail applicatif sérialisé en JSON. */
export interface GrpcErrorPayload {
  code: GrpcStatus;
  message: string;
  details: string;
}

/**
 * Convertit n'importe quelle erreur en erreur gRPC.
 * Une erreur inattendue devient INTERNAL avec un message générique : aucun détail interne
 * (trace, SQL, nom de serveur) ne quitte le service.
 */
export function toGrpcErrorPayload(error: unknown): GrpcErrorPayload {
  const appError =
    error instanceof AppError
      ? error
      : new AppError('INTERNAL', 'INTERNAL_ERROR', 'Une erreur interne est survenue. Réessayez plus tard.');
  const body = JSON.stringify({ code: appError.code, message: appError.message, details: appError.details });
  return { code: grpcStatusOf(appError.kind), message: body, details: body };
}

interface GrpcLikeError {
  code?: number;
  details?: string;
  message?: string;
}

/** Relit une erreur reçue d'un autre service et la reconstruit en AppError. */
export function fromGrpcError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const raw = (error ?? {}) as GrpcLikeError;
  const status = typeof raw.code === 'number' ? (raw.code as GrpcStatus) : GrpcStatus.UNKNOWN;
  const kind = STATUS_TO_KIND.get(status) ?? 'INTERNAL';
  const text = raw.details ?? raw.message ?? '';
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string; details?: ErrorDetails };
    if (parsed && typeof parsed.code === 'string') {
      return new AppError(kind, parsed.code, parsed.message ?? '', parsed.details ?? {});
    }
  } catch {
    // Erreur produite hors de nos services (réseau, grpc-js) : on garde un code générique.
  }
  return new AppError(
    kind,
    `GRPC_${GrpcStatus[status] ?? 'UNKNOWN'}`,
    text || 'Erreur de communication entre services.',
  );
}
