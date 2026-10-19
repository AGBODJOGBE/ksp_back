import { Controller, Get, Header } from '@nestjs/common';
import { GetSigningKeysUseCase } from '../../application/token/get-signing-keys.use-case';
import { type PublicSigningKey } from '../../application/token/token.ports';

/**
 * Clés publiques sur le port HTTP interne (ADR-020) : lues par la gateway et par tous les services
 * (IDENTITY_JWKS_URL) avec la bibliothèque jose, qui les garde en cache et les recharge si un jeton
 * porte une clé inconnue. La gateway relaie ce même document sur /.well-known/jwks.json en public.
 */
@Controller('.well-known')
export class JwksHttpController {
  constructor(private readonly getSigningKeys: GetSigningKeysUseCase) {}

  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=600')
  jwks(): { keys: PublicSigningKey[] } {
    return { keys: this.getSigningKeys.execute() };
  }
}
