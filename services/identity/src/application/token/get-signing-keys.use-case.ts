import { type PublicSigningKey, type TokenSigner } from './token.ports';

/** UC-ID-22 : clés publiques qui permettent de vérifier les jetons sans appeler identity. */
export class GetSigningKeysUseCase {
  constructor(private readonly signer: TokenSigner) {}

  execute(): PublicSigningKey[] {
    return this.signer.publicKeys();
  }
}
