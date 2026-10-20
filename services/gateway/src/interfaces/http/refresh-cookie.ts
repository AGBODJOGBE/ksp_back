import {
  type BrowserClientKind,
  REFRESH_COOKIE_PATH,
  refreshCookieMaxAge,
  refreshCookieName,
} from '../../domain/session/refresh-cookie';
import { type GatewayRequest, type GatewayResponse, header } from './http-types';

/**
 * Cookie de renouvellement des navigateurs (UC-GW-13, contrat OpenAPI) : HttpOnly (inaccessible au
 * JavaScript), Secure, SameSite=Strict, limité au chemin /api/v1/identity/token.
 */
export class RefreshCookies {
  constructor(private readonly secure: boolean) {}

  read(request: GatewayRequest, kind: BrowserClientKind): string | undefined {
    const name = refreshCookieName(kind, this.secure);
    for (const part of (header(request, 'cookie') ?? '').split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value) || undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  set(response: GatewayResponse, kind: BrowserClientKind, token: string, expiresAt: Date, now: Date): void {
    response.setHeader(
      'Set-Cookie',
      this.serialize(kind, encodeURIComponent(token), refreshCookieMaxAge(expiresAt, now)),
    );
  }

  clear(response: GatewayResponse, kind: BrowserClientKind): void {
    response.setHeader('Set-Cookie', this.serialize(kind, '', 0));
  }

  private serialize(kind: BrowserClientKind, value: string, maxAge: number): string {
    const attributes = [`Path=${REFRESH_COOKIE_PATH}`, `Max-Age=${maxAge}`, 'HttpOnly'];
    if (this.secure) attributes.push('Secure');
    attributes.push('SameSite=Strict');
    return [`${refreshCookieName(kind, this.secure)}=${value}`, ...attributes].join('; ');
  }
}
