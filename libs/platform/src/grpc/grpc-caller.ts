import { type Metadata } from '@grpc/grpc-js';
import CircuitBreaker from 'opossum';
import { firstValueFrom, isObservable, type Observable, throwError, timeout } from 'rxjs';
import { type ServiceTokenProvider } from '../auth/service-token';
import { metadataFromContext } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { fromGrpcError } from '../errors/grpc-error';

export interface GrpcCallerOptions {
  /** Service appelé, par exemple "notification". Sert aussi d'audience pour le jeton de service. */
  target: string;
  /** Délai par défaut d'un appel (cahier des charges Gateway, partie 4 : 3 secondes). */
  defaultDeadlineMs?: number;
  serviceTokenProvider?: ServiceTokenProvider;
  breaker?: {
    /** Pourcentage d'erreurs qui ouvre le coupe-circuit. */
    errorThresholdPercentage?: number;
    /** Nombre minimum d'appels avant de juger. */
    volumeThreshold?: number;
    /** Fenêtre d'observation en millisecondes. */
    rollingCountTimeout?: number;
    /** Délai avant un nouvel essai une fois ouvert. */
    resetTimeout?: number;
  };
  /** Pause entre deux tentatives, en millisecondes. */
  retryBackoffMs?: number;
}

export interface CallOptions {
  deadlineMs?: number;
  /**
   * Seules les lectures sont rejouées en cas d'échec réseau. Une écriture n'est jamais rejouée
   * automatiquement : elle passe par une clé d'idempotence.
   */
  idempotent?: boolean;
  retries?: number;
}

type Invoke<T> = (metadata: Metadata) => Observable<T> | Promise<T>;

/** Erreurs d'infrastructure : elles comptent pour le coupe-circuit et autorisent une nouvelle tentative. */
const INFRASTRUCTURE_KINDS = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Appel gRPC sortant avec les protections des règles d'or :
 * délai sur chaque appel, nouvelle tentative pour les lectures, coupe-circuit, propagation du contexte.
 */
export class GrpcCaller {
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;
  private readonly deadlineMs: number;

  constructor(private readonly options: GrpcCallerOptions) {
    this.deadlineMs = options.defaultDeadlineMs ?? 3000;
    this.breaker = new CircuitBreaker((run: () => Promise<unknown>) => run(), {
      timeout: false,
      errorThresholdPercentage: options.breaker?.errorThresholdPercentage ?? 50,
      volumeThreshold: options.breaker?.volumeThreshold ?? 20,
      rollingCountTimeout: options.breaker?.rollingCountTimeout ?? 10_000,
      resetTimeout: options.breaker?.resetTimeout ?? 30_000,
      // Une erreur métier (introuvable, conflit…) ne signifie pas que le service est en panne.
      errorFilter: (error: unknown) => !INFRASTRUCTURE_KINDS.has(fromGrpcError(error).kind),
    });
  }

  get isOpen(): boolean {
    return this.breaker.opened;
  }

  async call<T>(name: string, invoke: Invoke<T>, options: CallOptions = {}): Promise<T> {
    const attempts = options.idempotent ? 1 + (options.retries ?? 1) : 1;
    let lastError: AppError | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return (await this.breaker.fire(() =>
          this.once(name, invoke, options.deadlineMs ?? this.deadlineMs),
        )) as T;
      } catch (error) {
        lastError = this.normalize(error);
        const retryable = lastError.kind === 'UNAVAILABLE' || lastError.kind === 'DEADLINE_EXCEEDED';
        if (!retryable || this.breaker.opened || attempt === attempts - 1) break;
        await sleep((this.options.retryBackoffMs ?? 100) * (attempt + 1));
      }
    }
    throw lastError;
  }

  private async once<T>(name: string, invoke: Invoke<T>, deadlineMs: number): Promise<T> {
    const metadata = metadataFromContext();
    if (this.options.serviceTokenProvider) {
      metadata.set(
        'authorization',
        `Bearer ${await this.options.serviceTokenProvider.getToken(this.options.target)}`,
      );
    }
    const deadlineError = () =>
      new AppError(
        'DEADLINE_EXCEEDED',
        'GRPC_DEADLINE_EXCEEDED',
        `${this.options.target}.${name} n'a pas répondu à temps.`,
      );
    const result = invoke(metadata);
    if (isObservable(result)) {
      // Se désabonner annule l'appel gRPC en cours.
      return firstValueFrom(
        result.pipe(timeout({ first: deadlineMs, with: () => throwError(deadlineError) })),
      );
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(deadlineError()), deadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private normalize(error: unknown): AppError {
    if ((error as { code?: string })?.code === 'EOPENBREAKER') {
      return AppError.unavailable(
        `${this.options.target.toUpperCase()}_UNAVAILABLE`,
        'Ce service est momentanément indisponible. Réessayez dans quelques instants.',
      );
    }
    return fromGrpcError(error);
  }
}
