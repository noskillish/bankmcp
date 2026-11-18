// A complete OAuth 2.1 authorization server with exactly one user: you.
// The MCP SDK provides discovery, dynamic client registration, PKCE checks
// and the token endpoint; this file supplies the storage behind them and a
// password login page. Tokens are stored hashed.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidClientError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "./config.ts";
import { loginPage } from "./pages.ts";
import { clipName, oauthLog, redirectHost, registerDiag, tokenDiag } from "./oauth-log.ts";
export { loginPage, shell as page } from "./pages.ts";
import type { Store, OAuthClient } from "./store.ts";

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days
const CODE_TTL = 10 * 60;
const LOGIN_TTL = 30 * 60;

// --- Password ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string): boolean {
  if (config.adminPasswordHash) {
    const [scheme, salt, expected] = config.adminPasswordHash.split("$");
    if (scheme !== "scrypt" || !salt || !expected) return false;
    const actual = scryptSync(password, Buffer.from(salt, "base64"), 64);
    const exp = Buffer.from(expected, "base64");
    return actual.length === exp.length && timingSafeEqual(actual, exp);
  }
  if (config.adminPassword) {
    const a = Buffer.from(password);
    const b = Buffer.from(config.adminPassword);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return false;
}

export function redirectAllowed(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase();
    return config.allowedRedirectHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function cspNonce(): string {
  return randomBytes(16).toString("base64url");
}

// 'self' covers POST /login. A redirect origin is included only when this
// document's form may be followed by a redirect to that callback. The page
// after a successful password does not redirect the form; it navigates itself.
export function contentSecurityPolicy(opts: { redirectUri?: string; script?: boolean; scriptNonce?: string } = {}): string {
  const targets = opts.redirectUri ? formActionSources(opts.redirectUri) : [];
  const nonce = opts.scriptNonce && /^[A-Za-z0-9_-]+$/.test(opts.scriptNonce) ? opts.scriptNonce : undefined;
  const scriptSrc = nonce ? `script-src 'nonce-${nonce}'` : opts.script ? "script-src 'unsafe-inline'" : undefined;
  const directives = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ...(scriptSrc ? [scriptSrc] : []),
    `form-action 'self'${targets.length ? ` ${targets.join(" ")}` : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ];
  return directives.join("; ");
}

function formActionSources(redirectUri: string): string[] {
  if (!redirectAllowed(redirectUri)) return [];
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return [];
  }
  // Never copy a userinfo or a query (the authorization code) into the header.
  if (url.username || url.password) return [];
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin === "null" ? [] : [url.origin];
  if (url.protocol !== "cursor:") return [];
  const host = url.host.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return ["cursor:"];
  return ["cursor:", `cursor://${host}`];
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

// Authorization requests waiting for the password, keyed by a one-time id
// embedded in the login form. Memory only: they live ten minutes.
interface PendingLogin {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expires: number;
  attempts: number;
}

export interface LoginEvent {
  ok: boolean;
  ip: string;
  clientName?: string;
  clientId?: string;
  redirectHost?: string;
  state?: boolean;
  reason?: string;
}

type PendingFate = "expired" | "used" | "exhausted";

export class SingleUserProvider implements OAuthServerProvider {
  private pendingLogins = new Map<string, PendingLogin>();
  /** Why a sign-in id was dropped, so a later POST can say expired, used, or unknown. */
  private pendingFate = new Map<string, PendingFate>();
  /** sha256 of authorization codes already exchanged. The code itself is not kept. */
  private spentCodes = new Set<string>();
  private failures = new Map<string, { count: number; until: number }>();
  private store: Store;
  private onLogin?: (e: LoginEvent) => void;

  constructor(store: Store, opts: { onLogin?: (e: LoginEvent) => void } = {}) {
    this.store = store;
    this.onLogin = opts.onLogin;
  }

  /** Every token and pending code is dropped. Used when the admin password changes. */
  revokeAll(): void {
    this.pendingLogins.clear();
    this.pendingFate.clear();
    this.spentCodes.clear();
    this.store.update((d) => {
      d.oauth.tokens = {};
      d.oauth.codes = {};
    });
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store;
    return {
      getClient(clientId) {
        return store.data.oauth.clients[clientId] as OAuthClientInformationFull | undefined;
      },
      registerClient(client) {
        const registered = registerDiag.getStore();
        const fields = {
          client_name: clipName(client.client_name),
          redirect_hosts: client.redirect_uris.map((uri) => redirectHost(uri)),
          token_endpoint_auth_method: typeof client.token_endpoint_auth_method === "string" && client.token_endpoint_auth_method.trim()
            ? clipName(client.token_endpoint_auth_method)
            : "absent",
        };
        for (const uri of client.redirect_uris) {
          if (!redirectAllowed(uri)) {
            if (registered) registered.logged = true;
            oauthLog("register", { ...fields, ok: false });
            throw new InvalidClientMetadataError(`redirect_uri host not allowed: ${new URL(uri).hostname}. Set ALLOWED_REDIRECT_HOSTS on the server to permit it.`);
          }
        }
        // The SDK handler has already generated the id and, for confidential clients, the secret.
        const incoming = client as Partial<OAuthClient>;
        const full: OAuthClient = {
          ...(client as OAuthClient),
          client_id: incoming.client_id ?? randomBytes(16).toString("hex"),
          client_id_issued_at: incoming.client_id_issued_at ?? now(),
        };
        store.update((d) => {
          // Keep the store small: a connector re-registers when it is re-added.
          const ids = Object.keys(d.oauth.clients);
          if (ids.length > 20) for (const id of ids.slice(0, ids.length - 20)) delete d.oauth.clients[id];
          d.oauth.clients[full.client_id] = full;
        });
        if (registered) registered.logged = true;
        oauthLog("register", { ...fields, ok: true });
        return full as OAuthClientInformationFull;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    const id = token();
    this.pendingLogins.set(id, { client, params, expires: now() + LOGIN_TTL, attempts: 0 });
    const nonce = cspNonce();
    res
      .status(200)
      .set("Content-Security-Policy", contentSecurityPolicy({ redirectUri: params.redirectUri, scriptNonce: nonce }))
      .type("html")
      .send(loginPage({ requestId: id, clientName: client.client_name, returnTo: new URL(params.redirectUri).hostname, nonce }));
  }

  /** Called by POST /login. Returns the redirect URL on success, or an error message. */
  completeLogin(requestId: string, password: string, ip: string): { redirect: string } | { error: string; requestId?: string; redirectUri?: string } {
    this.sweep();
    const lock = this.failures.get(ip);
    if (lock && lock.until > now()) {
      this.onLogin?.({ ok: false, ip, reason: "locked out" });
      return { error: "Too many attempts. Try again in a few minutes." };
    }

    const pending = this.pendingLogins.get(requestId);
    if (!pending) {
      const fate = this.pendingFate.get(requestId) ?? "unknown";
      this.onLogin?.({ ok: false, ip, reason: `pending ${fate}` });
      const error = fate === "used"
        ? "This sign-in is already completed — return to your assistant"
        : "This sign-in page has expired or the server restarted. Go back to your assistant, click Connect again, and enter the password within 30 minutes.";
      return { error };
    }

    if (!verifyPassword(password)) {
      pending.attempts += 1;
      const f = this.failures.get(ip) ?? { count: 0, until: 0 };
      f.count += 1;
      if (f.count >= 5) f.until = now() + 15 * 60;
      this.failures.set(ip, f);
      if (pending.attempts >= 5) {
        this.pendingLogins.delete(requestId);
        this.noteFate(requestId, "exhausted");
      }
      this.onLogin?.({ ok: false, ip, clientName: pending.client.client_name, reason: "wrong password" });
      const again = pending.attempts < 5;
      return { error: "Wrong password.", requestId: again ? requestId : undefined, redirectUri: again ? pending.params.redirectUri : undefined };
    }

    this.pendingLogins.delete(requestId);
    this.noteFate(requestId, "used");
    this.failures.delete(ip);
    this.onLogin?.({
      ok: true,
      ip,
      clientName: pending.client.client_name,
      clientId: pending.client.client_id,
      redirectHost: new URL(pending.params.redirectUri).hostname,
      state: Boolean(pending.params.state),
    });
    const code = token();
    this.store.update((d) => {
      for (const [c, v] of Object.entries(d.oauth.codes)) if (v.expires < now()) delete d.oauth.codes[c];
      d.oauth.codes[sha256(code)] = {
        client_id: pending.client.client_id,
        code_challenge: pending.params.codeChallenge,
        redirect_uri: pending.params.redirectUri,
        resource: pending.params.resource?.href,
        scopes: pending.params.scopes ?? [],
        expires: now() + CODE_TTL,
      };
    });
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set("code", code);
    if (pending.params.state) url.searchParams.set("state", pending.params.state);
    return { redirect: url.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const key = sha256(authorizationCode);
    const c = this.store.data.oauth.codes[key];
    const state = this.codeState(key, c, client.client_id);
    const diag = tokenDiag.getStore();
    if (diag) {
      diag.code = state;
      if (state === "found") diag.pkce = "pending";
    }
    if (state !== "found" || !c) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const key = sha256(authorizationCode);
    const c = this.store.data.oauth.codes[key];
    const state = this.codeState(key, c, client.client_id);
    const diag = tokenDiag.getStore();
    // The SDK calls this only after the local PKCE check has passed.
    if (diag) {
      diag.code = state;
      diag.pkce = "ok";
    }
    if (state !== "found" || !c) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== c.redirect_uri) {
      if (diag) diag.redirect_match = false;
      throw new InvalidGrantError("redirect_uri does not match");
    }
    if (diag) diag.redirect_match = redirectUri ? true : "absent";
    if (resource && c.resource && resource.href !== c.resource) {
      if (diag) diag.resource_match = false;
      throw new InvalidGrantError("resource does not match");
    }
    if (diag) diag.resource_match = resource ? true : null;
    return this.store.update((d) => {
      delete d.oauth.codes[key];
      this.rememberSpent(key);
      return this.issue(d.oauth.tokens, client.client_id, c.scopes, c.resource);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const t = this.store.data.oauth.tokens[key];
    const diag = tokenDiag.getStore();
    if (!t || t.kind !== "refresh" || t.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (t.expires < now()) throw new InvalidGrantError("Refresh token expired");
    if (resource && t.resource && resource.href !== t.resource) {
      if (diag) diag.resource_match = false;
      throw new InvalidGrantError("resource does not match");
    }
    if (diag) diag.resource_match = resource ? true : null;
    return this.store.update((d) => {
      delete d.oauth.tokens[key];
      return this.issue(d.oauth.tokens, client.client_id, scopes?.length ? scopes : t.scopes, t.resource);
    });
  }

  async verifyAccessToken(tokenValue: string): Promise<AuthInfo> {
    const t = this.store.data.oauth.tokens[sha256(tokenValue)];
    if (!t || t.kind !== "access") throw new InvalidClientError("Invalid access token");
    if (t.expires < now()) throw new InvalidClientError("Access token expired");
    return { token: tokenValue, clientId: t.client_id, scopes: t.scopes, expiresAt: t.expires, resource: t.resource ? new URL(t.resource) : undefined };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    const t = this.store.data.oauth.tokens[key];
    if (t && t.client_id === client.client_id) this.store.update((d) => void delete d.oauth.tokens[key]);
  }

  private issue(tokens: Record<string, import("./store.ts").Token>, clientId: string, scopes: string[], resource?: string): OAuthTokens {
    for (const [k, v] of Object.entries(tokens)) if (v.expires < now()) delete tokens[k];
    const access = token();
    const refresh = token();
    tokens[sha256(access)] = { kind: "access", client_id: clientId, scopes, resource, expires: now() + ACCESS_TTL };
    tokens[sha256(refresh)] = { kind: "refresh", client_id: clientId, scopes, resource, expires: now() + REFRESH_TTL };
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  private noteFate(id: string, fate: PendingFate): void {
    this.pendingFate.set(id, fate);
    if (this.pendingFate.size <= 200) return;
    const oldest = this.pendingFate.keys().next().value;
    if (oldest) this.pendingFate.delete(oldest);
  }

  private rememberSpent(key: string): void {
    this.spentCodes.add(key);
    if (this.spentCodes.size <= 200) return;
    const oldest = this.spentCodes.values().next().value;
    if (oldest) this.spentCodes.delete(oldest);
  }

  private codeState(key: string, record: { client_id: string; expires: number } | undefined, clientId: string): TokenDiagCode {
    if (!record || record.client_id !== clientId) return this.spentCodes.has(key) ? "used" : "missing";
    if (record.expires < now()) return "expired";
    return "found";
  }

  private sweep() {
    const t = now();
    for (const [k, v] of this.pendingLogins) if (v.expires < t) {
      this.pendingLogins.delete(k);
      this.noteFate(k, "expired");
    }
    for (const [k, v] of this.failures) if (v.until && v.until < t) this.failures.delete(k);
  }
}

type TokenDiagCode = "found" | "expired" | "used" | "missing";
