/** Jetons d'injection partagés par la racine de composition et les adaptateurs. */
export const CLOCK = Symbol('CLOCK');
export const JWKS_SOURCE = Symbol('JWKS_SOURCE');
export const RATE_LIMITER = Symbol('RATE_LIMITER');
export const IDENTITY_GRPC_CLIENT = Symbol('IDENTITY_GRPC_CLIENT');
export const CLEANING_GRPC_CLIENT = Symbol('CLEANING_GRPC_CLIENT');
export const CLEANING_API = Symbol('CLEANING_API');
export const BILLING_GRPC_CLIENT = Symbol('BILLING_GRPC_CLIENT');
export const BILLING_API = Symbol('BILLING_API');
export const ORGANIZATIONS_API = Symbol('ORGANIZATIONS_API');
export const ACCOUNT_ADMIN_API = Symbol('ACCOUNT_ADMIN_API');
