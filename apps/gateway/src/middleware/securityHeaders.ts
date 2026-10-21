import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * Strict Content-Security-Policy directives for the gateway.
 *
 * The gateway serves JSON APIs and does not render HTML, so the policy is
 * locked down to the most restrictive values that still allow the gateway
 * to function. `default-src 'none'` blocks every resource type unless it is
 * explicitly re-enabled below.
 */
const contentSecurityPolicyDirectives = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  fontSrc: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
  imgSrc: ["'none'"],
  objectSrc: ["'none'"],
  scriptSrc: ["'none'"],
  styleSrc: ["'none'"],
  connectSrc: ["'self'"],
  upgradeInsecureRequests: [],
};

/**
 * Helmet middleware configured with strict security headers for the gateway.
 *
 * Applies, among others:
 * - `Content-Security-Policy` (strict, deny-by-default)
 * - `X-Content-Type-Options: nosniff`
 * - `Strict-Transport-Security` (HSTS)
 * - `X-Frame-Options`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, etc.
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: contentSecurityPolicyDirectives,
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: { policy: 'same-site' },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: {
    maxAge: 31536000, // 1 year, in seconds
    includeSubDomains: true,
    preload: true,
  },
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  referrerPolicy: { policy: 'no-referrer' },
  xssFilter: true,
});

export default securityHeaders;
