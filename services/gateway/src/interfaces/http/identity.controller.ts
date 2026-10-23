import { AppError } from '@ksp/platform';
import { Body, Controller, Inject, Req, Res } from '@nestjs/common';
import { type Clock } from '../../application/access/access.ports';
import { type SessionTokens } from '../../application/identity/identity.ports';
import {
  ConfirmTotpUseCase,
  EnrollTotpUseCase,
  GetMeUseCase,
  LogoutUseCase,
  RefreshSessionUseCase,
  RequestOtpUseCase,
  UpdateMeUseCase,
  VerifyMfaUseCase,
  VerifyOtpUseCase,
} from '../../application/identity/identity.use-cases';
import { type ClientKind, refreshTokenTransport } from '../../domain/client/client-kind';
import { CLOCK } from '../../tokens';
import { type GatewayRequest, type GatewayResponse } from './http-types';
import {
  presentMfaRequired,
  presentOtpChallenge,
  presentProfile,
  presentSession,
  presentTotpEnrollment,
} from './presenters';
import { RefreshCookies } from './refresh-cookie';
import { Route } from './route.decorator';
import { isEmptyBody, parseBody, requestBodies } from './schemas';

/** Erreurs d'identity qui rendent le cookie de renouvellement inutilisable : on l'efface. */
const DEAD_SESSION_CODES = new Set([
  'IDENTITY_REFRESH_TOKEN_INVALID',
  'IDENTITY_REFRESH_TOKEN_REUSED',
  'IDENTITY_SESSION_REVOKED',
  // Session back-office fermée par identity : plus aucun rôle du back-office.
  'IDENTITY_BACKOFFICE_FORBIDDEN',
]);

/**
 * Routes /api/v1/identity/* (contrat OpenAPI) : validation du corps, appel du cas d'usage,
 * mise en forme de la réponse et cookie de renouvellement des navigateurs (UC-GW-13).
 */
@Controller()
export class IdentityHttpController {
  constructor(
    private readonly requestOtpUseCase: RequestOtpUseCase,
    private readonly verifyOtpUseCase: VerifyOtpUseCase,
    private readonly refreshSessionUseCase: RefreshSessionUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly getMeUseCase: GetMeUseCase,
    private readonly updateMeUseCase: UpdateMeUseCase,
    private readonly enrollTotpUseCase: EnrollTotpUseCase,
    private readonly confirmTotpUseCase: ConfirmTotpUseCase,
    private readonly verifyMfaUseCase: VerifyMfaUseCase,
    private readonly cookies: RefreshCookies,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Route('requestOtp')
  async requestOtp(@Body() body: unknown) {
    const input = parseBody(requestBodies.requestOtp, body);
    return presentOtpChallenge(await this.requestOtpUseCase.execute(input));
  }

  @Route('verifyOtp')
  async verifyOtp(
    @Body() body: unknown,
    @Req() request: GatewayRequest,
    @Res({ passthrough: true }) response: GatewayResponse,
  ) {
    const input = parseBody(requestBodies.verifyOtp, body);
    const clientKind = knownClient(request);
    const outcome = await this.verifyOtpUseCase.execute({ ...input, clientKind });
    if (outcome.status === 'mfa_required') return presentMfaRequired(outcome.challenge);
    return { ...this.deliver(outcome.session, clientKind, response), isNewUser: outcome.isNewUser };
  }

  @Route('enrollTotp')
  async enrollTotp(@Body() body: unknown, @Req() request: GatewayRequest) {
    const input = parseBody(requestBodies.enrollTotp, body);
    return presentTotpEnrollment(
      await this.enrollTotpUseCase.execute({ ...input, clientKind: knownClient(request) }),
    );
  }

  /** Fin de la configuration : session ouverte, cookie __Secure-ksp_admin_rt posé au back-office. */
  @Route('confirmTotp')
  async confirmTotp(
    @Body() body: unknown,
    @Req() request: GatewayRequest,
    @Res({ passthrough: true }) response: GatewayResponse,
  ) {
    const input = parseBody(requestBodies.confirmTotp, body);
    const clientKind = knownClient(request);
    const result = await this.confirmTotpUseCase.execute({ ...input, clientKind });
    return { ...this.deliver(result.session, clientKind, response), recoveryCodes: result.recoveryCodes };
  }

  @Route('verifyMfa')
  async verifyMfa(
    @Body() body: unknown,
    @Req() request: GatewayRequest,
    @Res({ passthrough: true }) response: GatewayResponse,
  ) {
    const input = parseBody(requestBodies.verifyMfa, body);
    const clientKind = knownClient(request);
    const result = await this.verifyMfaUseCase.execute({ ...input, clientKind });
    return {
      ...this.deliver(result.session, clientKind, response),
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    };
  }

  @Route('refreshSession')
  async refreshSession(
    @Body() body: unknown,
    @Req() request: GatewayRequest,
    @Res({ passthrough: true }) response: GatewayResponse,
  ) {
    const clientKind = knownClient(request);
    const input: { refreshToken?: string } = isEmptyBody(body)
      ? {}
      : parseBody(requestBodies.refreshSession, body);
    const browser = clientKind === 'mobile' ? null : clientKind;
    try {
      const session = await this.refreshSessionUseCase.execute({
        clientKind,
        bodyToken: input.refreshToken,
        cookieToken: browser ? this.cookies.read(request, browser) : undefined,
      });
      return this.deliver(session, clientKind, response);
    } catch (error) {
      if (browser && error instanceof AppError && DEAD_SESSION_CODES.has(error.code)) {
        this.cookies.clear(response, browser);
      }
      throw error;
    }
  }

  @Route('logout')
  async logout(
    @Body() body: unknown,
    @Req() request: GatewayRequest,
    @Res({ passthrough: true }) response: GatewayResponse,
  ) {
    const input: { scope?: 'this_device' | 'all_devices' } = isEmptyBody(body)
      ? {}
      : parseBody(requestBodies.logout, body);
    const revokedSessions = await this.logoutUseCase.execute(input);
    const clientKind = knownClient(request);
    if (clientKind !== 'mobile') this.cookies.clear(response, clientKind);
    return { revokedSessions };
  }

  @Route('getMe')
  async getMe() {
    return presentProfile(await this.getMeUseCase.execute());
  }

  @Route('updateMe')
  async updateMe(@Body() body: unknown) {
    return presentProfile(await this.updateMeUseCase.execute(parseBody(requestBodies.updateMe, body)));
  }

  /** Navigateur : jeton de renouvellement dans le cookie ; mobile : dans le corps. */
  private deliver(session: SessionTokens, clientKind: ClientKind, response: GatewayResponse) {
    const inBody = refreshTokenTransport(clientKind) === 'body';
    if (clientKind !== 'mobile') {
      this.cookies.set(
        response,
        clientKind,
        session.refreshToken,
        new Date(session.refreshTokenExpiresAt),
        this.clock.now(),
      );
    }
    return presentSession(session, inBody);
  }
}

/** Type de client d'une route d'authentification : le garde l'a déjà exigé. */
function knownClient(request: GatewayRequest): ClientKind {
  const kind = request.gateway?.clientKind;
  if (!kind) throw AppError.invalid('GATEWAY_CLIENT_UNKNOWN', "Ce client n'est pas autorisé à se connecter.");
  return kind;
}
