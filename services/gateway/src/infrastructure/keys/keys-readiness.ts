import { ReadinessRegistry } from '@ksp/platform';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SigningKeysCache } from './signing-keys-cache';

/** Sonde « prêt » : la gateway ne reçoit du trafic qu'avec les clés publiques d'identity en cache (UC-GW-16). */
@Injectable()
export class KeysReadiness implements OnModuleInit {
  constructor(
    private readonly registry: ReadinessRegistry,
    private readonly keys: SigningKeysCache,
  ) {}

  onModuleInit(): void {
    this.registry.register('identity-keys', () => this.keys.ensureLoaded());
  }
}
