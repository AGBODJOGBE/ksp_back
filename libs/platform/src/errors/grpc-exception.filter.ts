import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type Observable, throwError } from 'rxjs';
import { AppError } from './app-error';
import { toGrpcErrorPayload } from './grpc-error';

/**
 * Filtre global : toute erreur levée par un contrôleur gRPC sort au format commun.
 * Les erreurs inattendues sont journalisées avec leur trace, mais masquées pour l'appelant.
 */
@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): Observable<never> | void {
    if (host.getType() === 'http') {
      // Seules les sondes de santé et les métriques passent par HTTP dans un service.
      const response = host
        .switchToHttp()
        .getResponse<{ status(code: number): { json(body: unknown): void } }>();
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      response.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR' } });
      return;
    }
    if (!(exception instanceof AppError)) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    return throwError(() => toGrpcErrorPayload(exception));
  }
}
