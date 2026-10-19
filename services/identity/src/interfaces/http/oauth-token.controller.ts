import { type ServiceTokenResponse } from '@ksp/contracts';
import { Body, Controller, Headers, HttpCode, Logger, Post, Res } from '@nestjs/common';
import {
  IssueServiceTokenUseCase,
  ServiceTokenError,
} from '../../application/service-token/issue-service-token.use-case';

/** Réponse HTTP minimale : la route écrit elle-même son format, imposé par la norme OAuth 2.0. */
interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

type TokenRequestBody = Partial<Record<'grant_type' | 'client_id' | 'client_secret' | 'audience', string>>;

/** Identifiants envoyés en en-tête « Authorization: Basic » (RFC 6749, section 2.3.1). */
function basicCredentials(header: string | undefined): { clientId?: string; clientSecret?: string } {
  if (!header?.startsWith('Basic ')) return {};
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return {};
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}

/**
 * Émission des jetons de service (OAuth 2.0 client credentials, ADR-022), sur le port HTTP interne :
 * un appel gRPC exigerait déjà un jeton de service. Jamais exposée hors du cluster.
 */
@Controller('oauth')
export class OAuthTokenHttpController {
  private readonly logger = new Logger(OAuthTokenHttpController.name);

  constructor(private readonly issueServiceToken: IssueServiceTokenUseCase) {}

  @Post('token')
  @HttpCode(200)
  async token(
    @Body() body: TokenRequestBody,
    @Headers('authorization') authorization: string | undefined,
    @Res() res: HttpResponse,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const basic = basicCredentials(authorization);
    try {
      const issued = await this.issueServiceToken.execute({
        grantType: body?.grant_type,
        clientId: basic.clientId ?? body?.client_id,
        clientSecret: basic.clientSecret ?? body?.client_secret,
        audience: body?.audience,
      });
      const response: ServiceTokenResponse = {
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
      };
      res.status(200).json(response);
    } catch (error) {
      if (!(error instanceof ServiceTokenError)) throw error;
      // Jamais le secret dans les journaux : seulement le client et le motif.
      this.logger.warn(
        `Jeton de service refusé (${error.code}) pour ${basic.clientId ?? body?.client_id ?? '?'}`,
      );
      if (error.code === 'invalid_client' && basic.clientId) res.setHeader('WWW-Authenticate', 'Basic');
      res.status(error.code === 'invalid_client' ? 401 : 400).json({
        error: error.code,
        error_description: error.message,
      });
    }
  }
}
