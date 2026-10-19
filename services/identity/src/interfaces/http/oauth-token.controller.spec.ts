import {
  type IssueServiceTokenInput,
  type IssueServiceTokenUseCase,
  ServiceTokenError,
} from '../../application/service-token/issue-service-token.use-case';
import { OAuthTokenHttpController } from './oauth-token.controller';

function response() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

function controller(outcome: () => Promise<{ accessToken: string; expiresIn: number }>) {
  const inputs: IssueServiceTokenInput[] = [];
  const useCase = {
    execute: (input: IssueServiceTokenInput) => {
      inputs.push(input);
      return outcome();
    },
  } as unknown as IssueServiceTokenUseCase;
  return { inputs, http: new OAuthTokenHttpController(useCase) };
}

const form = {
  grant_type: 'client_credentials',
  client_id: 'gateway',
  client_secret: 's',
  audience: 'identity',
};

describe('OAuthTokenHttpController', () => {
  it('répond au format OAuth 2.0, sans mise en cache', async () => {
    const { http } = controller(async () => ({ accessToken: 'jwt', expiresIn: 300 }));
    const res = response();
    await http.token(form, undefined, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ access_token: 'jwt', token_type: 'Bearer', expires_in: 300 });
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  });

  it('accepte les identifiants en en-tête Basic', async () => {
    const { http, inputs } = controller(async () => ({ accessToken: 'jwt', expiresIn: 300 }));
    const basic = `Basic ${Buffer.from('gateway:secret-basic').toString('base64')}`;
    await http.token({ grant_type: 'client_credentials', audience: 'identity' }, basic, response());
    expect(inputs[0]).toMatchObject({ clientId: 'gateway', clientSecret: 'secret-basic' });
  });

  it.each([
    ['invalid_client', 401],
    ['invalid_target', 400],
    ['invalid_request', 400],
    ['unsupported_grant_type', 400],
  ] as const)('traduit %s en HTTP %i', async (code, status) => {
    const { http } = controller(async () => {
      throw new ServiceTokenError(code, 'refusé');
    });
    const res = response();
    await http.token(form, undefined, res);
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: code, error_description: 'refusé' });
  });
});
