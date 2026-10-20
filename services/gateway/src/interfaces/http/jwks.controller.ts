import { Controller, Header } from '@nestjs/common';
import { GetPublicKeysUseCase } from '../../application/keys/public-keys';
import { Route } from './route.decorator';

/**
 * Clés publiques de vérification des jetons d'accès (UC-ID-22), servies depuis le cache de la
 * gateway : identity n'est pas sollicité à chaque lecture.
 */
@Controller()
export class JwksHttpController {
  constructor(private readonly getPublicKeys: GetPublicKeysUseCase) {}

  @Route('getJwks')
  @Header('Cache-Control', 'public, max-age=600')
  jwks() {
    return this.getPublicKeys.execute();
  }
}
