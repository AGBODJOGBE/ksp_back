import { type ServiceTokenProvider } from '@ksp/platform';
import { type IssueServiceTokenUseCase } from '../../application/service-token/issue-service-token.use-case';

/** Jetons d'identity pour ses propres appels (vers notification) : signés sur place, sans aller-retour HTTP. */
export class LocalServiceTokenProvider implements ServiceTokenProvider {
  constructor(private readonly issuer: IssueServiceTokenUseCase) {}

  async getToken(audience: string): Promise<string> {
    return (await this.issuer.issueForIdentity(audience)).accessToken;
  }
}
