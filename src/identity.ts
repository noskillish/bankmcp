// Fleet identity: this server as an OAuth resource only (fork-specific, not upstream).
//
// Off unless SR_IDENTITY_URL is set; unset, app.ts behaves exactly as upstream. When set,
// sr-ops-os (Supabase Auth) is the only authorization server:
//   - /.well-known/oauth-protected-resource[/mcp] names `${SR_IDENTITY_URL}/auth/v1` as issuer
//   - /mcp needs a Supabase access token: ES256/RS256 against the project JWKS, iss,
//     aud=authenticated, role=authenticated, exp/nbf, then the owner gate
//   - the local authorization server (/register, /authorize, /token, /revoke, /login,
//     /.well-known/oauth-authorization-server) answers 404
//
// Config (names only; values live in Doppler):
//   SR_IDENTITY_URL             Supabase project URL (https)
//   SR_IDENTITY_ALLOWED_SUBS    comma/space separated user ids
//   SR_IDENTITY_ALLOWED_EMAILS  comma/space separated emails
//   BASE_URL                    public origin; the resource is BASE_URL + /mcp
// With SR_IDENTITY_URL set and both allowlists empty the server refuses to start.
//
// Switch on: set the names in Doppler -> one deploy -> read back
//   GET /.well-known/oauth-protected-resource (authorization_servers = the issuer),
//   POST /mcp without a token (401 + WWW-Authenticate resource_metadata), GET
//   /.well-known/oauth-authorization-server (404), then one real sign-in via the claude.ai
//   connector.
// Rollback: unset SR_IDENTITY_URL and redeploy. The local OAuth server and password sign-in
// come back; keep admin_password_hash in DATA_DIR so /setup stays closed.
//
// The JWKS verifier below is a verbatim copy of srosenlund/sr-ops-os lib/auth/jwks.ts.
// Nothing here logs a token, a key or a claim value.

import type { Express, RequestHandler } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InsufficientScopeError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface Identity {
  /** Supabase project URL without a trailing slash. */
  url: string;
  issuer: string;
  allowedSubs: string[];
  allowedEmails: string[];
}

/** Null when SR_IDENTITY_URL is unset. Throws (refuse to start) on a bad URL or no allowlist. */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): Identity | null {
  const url = (env.SR_IDENTITY_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SR_IDENTITY_URL must be an absolute https URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("SR_IDENTITY_URL must be an absolute https URL");
  const list = (name: string) => (env[name] ?? "").split(/[,\s]+/).filter(Boolean);
  const allowedSubs = list("SR_IDENTITY_ALLOWED_SUBS");
  const allowedEmails = list("SR_IDENTITY_ALLOWED_EMAILS").map((e) => e.toLowerCase());
  if (!allowedSubs.length && !allowedEmails.length) {
    throw new Error("SR_IDENTITY_URL is set but SR_IDENTITY_ALLOWED_SUBS and SR_IDENTITY_ALLOWED_EMAILS are both empty");
  }
  return { url, issuer: `${url}/auth/v1`, allowedSubs, allowedEmails };
}

/** Signature, iss, aud, exp/nbf, role, then the owner gate. */
export async function verifyOwnerToken(token: string, identity: Identity): Promise<AuthInfo> {
  const result = await verifyAccessToken(token, { supabaseUrl: identity.url, issuer: identity.issuer });
  if (!result.ok) {
    if (result.reason === "jwks_unavailable") throw new ServerError("Identity keys unavailable");
    throw new InvalidTokenError(result.reason === "expired" ? "Access token expired" : `Invalid access token (${result.reason})`);
  }
  const { claims } = result;
  if (claims.role !== "authenticated") throw new InvalidTokenError("Invalid access token (role)");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const owner = identity.allowedSubs.includes(claims.sub) || (email !== "" && identity.allowedEmails.includes(email));
  if (!owner) throw new InsufficientScopeError("Token user is not the owner of this server");
  return {
    token,
    clientId: typeof claims.client_id === "string" ? claims.client_id : "sr-identity",
    scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
    expiresAt: claims.exp,
  };
}

/**
 * Mount the identity routes ahead of upstream's routes and return the /mcp bearer gate.
 * Express answers in registration order, so the 404s here shadow the local authorization
 * server mounted later in app.ts.
 */
export function mountIdentity(app: Express, identity: Identity, mcpUrl: URL): RequestHandler {
  const metadata = {
    resource: mcpUrl.href,
    authorization_servers: [identity.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
  };
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json(metadata);
  });
  app.use(["/register", "/authorize", "/token", "/revoke", "/login", "/.well-known/oauth-authorization-server"], (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return requireBearerAuth({
    verifier: { verifyAccessToken: (token) => verifyOwnerToken(token, identity) },
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
}

// --- verbatim copy of srosenlund/sr-ops-os lib/auth/jwks.ts below ---

import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey as NodeJsonWebKey,
  type KeyObject,
} from "node:crypto";

/** Header and claim shapes, limited to what this module reads. */
export interface AccessTokenHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

export interface AccessTokenClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  email?: string;
  role?: string;
  session_id?: string;
  user_metadata?: { full_name?: string; name?: string; [claim: string]: unknown };
  [claim: string]: unknown;
}

export type VerifyFailure =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "jwks_unavailable"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "bad_issuer"
  | "bad_audience"
  | "missing_subject";

export type VerifyResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: VerifyFailure };

export interface JwksOptions {
  /** `https://<ref>.supabase.co`; the default issuer and JWKS URL are derived from it. */
  supabaseUrl: string;
  /** Defaults to `<supabaseUrl>/auth/v1`. */
  issuer?: string;
  /** Defaults to `authenticated`, the audience of a Supabase user access token. */
  audience?: string | readonly string[];
  /** Defaults to `<supabaseUrl>/auth/v1/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** Tolerance on `exp` and `nbf`, in seconds. Defaults to 5. */
  clockSkewSeconds?: number;
  /** How long a fetched key set stays fresh. Defaults to 5 minutes. */
  cacheTtlMs?: number;
  /** Floor between two forced refetches after an unknown `kid`. Defaults to 30 seconds. */
  minRefreshIntervalMs?: number;
  /** Injectable clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable fetch, for tests and for hosts that need a custom agent. */
  fetch?: typeof globalThis.fetch;
}

interface JsonWebKey {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface KeySet {
  keys: Map<string, KeyObject>;
  /** The only key, when the set holds exactly one and a token omits `kid`. */
  only?: KeyObject;
  fetchedAt: number;
}

interface Algorithm {
  hash: string;
  dsaEncoding?: "ieee-p1363";
}

/** Asymmetric only: a symmetric algorithm cannot be verified against a public key. */
const ALGORITHMS: Readonly<Record<string, Algorithm>> = {
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
  RS256: { hash: "sha256" },
};

const cache = new Map<string, KeySet>();
const inFlight = new Map<string, Promise<KeySet>>();
/** When a key set was last refetched because of an unknown `kid`, per JWKS. */
const forcedAt = new Map<string, number>();

/** Drop cached keys, all of them or one JWKS. For tests and for a forced rotation. */
export function clearJwksCache(jwksUrl?: string): void {
  if (jwksUrl) {
    cache.delete(jwksUrl);
    forcedAt.delete(jwksUrl);
  } else {
    cache.clear();
    forcedAt.clear();
  }
}

function trimOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function fetchKeys(url: string, options: JwksOptions, now: number): Promise<KeySet> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    // A key set is small and public; `no-store` keeps a proxy from serving a stale set after a
    // rotation, while the in-process cache below does the real work.
    cache: "no-store",
  });
  if (!response.ok) throw new Error("jwks status");
  const document = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(document?.keys)) throw new Error("jwks shape");
  const keys = new Map<string, KeyObject>();
  for (const candidate of document.keys as JsonWebKey[]) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.use && candidate.use !== "sig") continue;
    if (candidate.kty !== "EC" && candidate.kty !== "RSA") continue;
    try {
      const key = createPublicKey({ key: candidate as unknown as NodeJsonWebKey, format: "jwk" });
      // A key without `kid` still helps a single-key project, so it is kept under "".
      keys.set(typeof candidate.kid === "string" ? candidate.kid : "", key);
    } catch {
      // A key this runtime cannot read is skipped; another key may still verify the token.
    }
  }
  if (keys.size === 0) throw new Error("jwks empty");
  const set: KeySet = { keys, fetchedAt: now };
  if (keys.size === 1) set.only = keys.values().next().value as KeyObject;
  return set;
}

async function loadKeys(url: string, options: JwksOptions, force: boolean): Promise<KeySet | null> {
  const now = options.now?.() ?? Date.now();
  const cached = cache.get(url);
  if (cached && !force && now - cached.fetchedAt < (options.cacheTtlMs ?? 300_000)) return cached;
  if (cached && force) {
    // An unknown `kid` must not turn into a fetch per request: a set fetched a moment ago, by the
    // cache or by this same rotation, would come back unchanged.
    const lastFetch = Math.max(forcedAt.get(url) ?? 0, cached.fetchedAt);
    if (now - lastFetch < (options.minRefreshIntervalMs ?? 30_000)) return cached;
  }
  const pending = inFlight.get(url);
  if (pending) return pending;
  const request = fetchKeys(url, options, now)
    .then((set) => {
      cache.set(url, set);
      if (force) forcedAt.set(url, now);
      return set;
    })
    .finally(() => {
      inFlight.delete(url);
    });
  inFlight.set(url, request);
  try {
    return await request;
  } catch {
    return cached ?? null;
  }
}

/**
 * Verify a Supabase access token and return its claims.
 *
 * @example
 * const result = await verifyAccessToken(token, { supabaseUrl: process.env.SUPABASE_URL! });
 * if (!result.ok) return new Response("unauthorized", { status: 401 });
 * const { sub, email } = result.claims;
 */
export async function verifyAccessToken(token: string, options: JwksOptions): Promise<VerifyResult> {
  const origin = trimOrigin(options.supabaseUrl);
  const issuer = options.issuer ?? `${origin}/auth/v1`;
  const jwksUrl = options.jwksUrl ?? `${origin}/auth/v1/.well-known/jwks.json`;
  const audience = options.audience ?? "authenticated";
  const skew = options.clockSkewSeconds ?? 5;

  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const segments = token.split(".");
  const [rawHeader, rawPayload, rawSignature] = segments;
  if (segments.length !== 3 || !rawHeader || !rawPayload || !rawSignature) {
    return { ok: false, reason: "malformed" };
  }

  const header = decodeSegment(rawHeader) as AccessTokenHeader | undefined;
  if (!header || typeof header.alg !== "string") return { ok: false, reason: "malformed" };
  const algorithm = ALGORITHMS[header.alg];
  if (!algorithm) return { ok: false, reason: "unsupported_algorithm" };
  const kid = typeof header.kid === "string" ? header.kid : "";

  let set = await loadKeys(jwksUrl, options, false);
  if (!set) return { ok: false, reason: "jwks_unavailable" };
  let key = set.keys.get(kid) ?? (kid ? undefined : set.only);
  if (!key) {
    set = await loadKeys(jwksUrl, options, true);
    if (!set) return { ok: false, reason: "jwks_unavailable" };
    key = set.keys.get(kid) ?? (kid ? undefined : set.only);
    if (!key) return { ok: false, reason: "unknown_key" };
  }

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`);
  const signature = Buffer.from(rawSignature, "base64url");
  const signatureOk = verifySignature(
    algorithm.hash,
    signed,
    algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key,
    signature,
  );
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  const claims = decodeSegment(rawPayload) as AccessTokenClaims | undefined;
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    return { ok: false, reason: "malformed" };
  }
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (claims.iss !== issuer) return { ok: false, reason: "bad_issuer" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expected = Array.isArray(audience) ? audience : [audience];
  if (!expected.some((value) => audiences.includes(value))) {
    return { ok: false, reason: "bad_audience" };
  }
  if (typeof claims.exp !== "number" || nowSeconds > claims.exp + skew) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && nowSeconds + skew < claims.nbf) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (typeof claims.sub !== "string" || !claims.sub) {
    return { ok: false, reason: "missing_subject" };
  }
  return { ok: true, claims };
}
