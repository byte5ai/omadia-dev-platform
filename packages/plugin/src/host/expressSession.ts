/**
 * SEAM — was `middleware/src/auth/requireAuth.ts`'s global augmentation.
 *
 * `routes/devPlatformShared.ts:requireCaller` reads `req.session` — the claims
 * core's `requireAuth` middleware attaches. Core declared that property by
 * augmenting `express-serve-static-core`; the plugin compiles on its own, so it
 * must declare it too or `tsc` sees a bare `Request`.
 *
 * At RUNTIME nothing changes: `ctx.routes.register(prefix, router, {auth:
 * 'session'})` composes the kernel's own session gate around the router (epic
 * #470 C6 / G2), and that gate is the same code path that sets the property.
 * This file only tells the type checker what the kernel already does.
 *
 * `requireCaller` still treats every field as `unknown` and re-checks it
 * (`typeof s?.sub === 'string'`), which is why the shape being a structural copy
 * rather than the imported type is safe: a drift in core's claims cannot smuggle
 * a wrong-typed value past the route, it can only make a field absent — and
 * absent is already a 401.
 */

/** Structural copy of core's `SessionClaims`, narrowed to what this plugin
 *  reads. Extra core fields are irrelevant here and deliberately not mirrored:
 *  copying fields nobody reads only creates something to drift. */
export interface DevPlatformSessionClaims {
  /** Stable per-user identifier within the issuing provider. */
  sub: string;
  email: string;
  /** Whitelist label — currently always 'admin' until roles split. */
  role: string;
  [key: string]: unknown;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: DevPlatformSessionClaims;
  }
}
